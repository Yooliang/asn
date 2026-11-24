import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  handleReport, handleReportGet, parseReport, parseReportGet, rejectResult, reportBellPayload, REPORT_ACTIONS, REPORT_MAX_BYTES,
} from "./report.ts";
import type { RpcFn } from "./partners.ts";
import { WEB_ALLOWED_ACTIONS, WEB_DENIED_ACTIONS } from "./web_session.ts";

const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const e = console.error;
  console.error = () => {};
  try { return await f(); } finally { console.error = e; }
};

Deno.test("parseReport：kind 格式、payload 必須是物件、大小上限；多餘欄位（含節點代號）丟掉", () => {
  assertEquals(parseReport({ kind: "echo", payload: { text: "x" }, node: "evil" }), { kind: "echo", payload: { text: "x" } });
  for (const kind of ["", "Echo", "1echo", "echo-x", "a".repeat(33), "echo ", 5, null]) {
    assertEquals((parseReport({ kind, payload: {} }) as { status: number }).status, 400, String(kind));
  }
  assertEquals(parseReport({ kind: "a".repeat(32), payload: {} }), { kind: "a".repeat(32), payload: {} });
  for (const payload of [null, "s", 5, [], [1], undefined]) {
    assertEquals((parseReport({ kind: "echo", payload }) as { status: number }).status, 400);
  }
  for (const b of [null, "x", [], 5, {}]) assertEquals((parseReport(b) as { status: number }).status, 400);
  // 剛好上限通過、多一位元組 413；用多位元組字元確認算的是位元組不是字數
  const pad = (n: number) => ({ t: "x".repeat(n) });
  const base = new TextEncoder().encode(JSON.stringify(pad(0))).length;
  assert(!("error" in parseReport({ kind: "echo", payload: pad(REPORT_MAX_BYTES - base) })));
  assertEquals((parseReport({ kind: "echo", payload: pad(REPORT_MAX_BYTES - base + 1) }) as { status: number }).status, 413);
  assertEquals((parseReport({ kind: "echo", payload: { t: "中".repeat(30000) } }) as { status: number }).status, 413);
});

Deno.test("parseReportGet：nodes 去重後 1～50 個、格式要合；kind 格式要合", () => {
  assertEquals(parseReportGet({ kind: "echo", nodes: ["a", "b", "a", "c", "b"] }), { kind: "echo", nodes: ["a", "b", "c"] });
  const ids = (n: number) => Array.from({ length: n }, (_, i) => "n" + i);
  assertEquals((parseReportGet({ kind: "echo", nodes: ids(50) }) as { nodes: string[] }).nodes.length, 50);
  assertEquals((parseReportGet({ kind: "echo", nodes: [...ids(50), "n0", "n1"] }) as { nodes: string[] }).nodes.length, 50, "去重後才算");
  for (const b of [
    null, "x", {}, { kind: "echo" }, { kind: "echo", nodes: [] }, { kind: "echo", nodes: "a" }, { kind: "echo", nodes: ids(51) },
    { kind: "echo", nodes: ["a b"] }, { kind: "echo", nodes: ["x".repeat(33)] }, { kind: "echo", nodes: [1] }, { kind: "echo", nodes: ["a", null] },
    { kind: "Echo", nodes: ["a"] }, { kind: 5, nodes: ["a"] },
  ]) assertEquals((parseReportGet(b) as { status: number }).status, 400, JSON.stringify(b));
});

Deno.test("rejectResult：rate／rate_node 429 並帶 retry_after_seconds，其他 422；不認得的原因不外洩原文", async () => {
  assertEquals(rejectResult({ rejected_reason: "rate", retry_after_seconds: 3 }).status, 429);
  assertEquals((rejectResult({ rejected_reason: "rate", retry_after_seconds: 3 }).body as Record<string, unknown>).retry_after_seconds, 3);
  assertEquals((rejectResult({ rejected_reason: "rate_node", retry_after_seconds: 2.2 }).body as Record<string, unknown>).retry_after_seconds, 3);
  assertEquals((rejectResult({ rejected_reason: "rate" }).body as Record<string, unknown>).retry_after_seconds, 1);
  for (const r of ["unknown_kind", "disabled", "no_rule", "not_object", "too_large", "unknown_field", "type_mismatch", "missing_required", "too_long", "too_many",
    "out_of_range", "bad_enum", "looks_like_email", "looks_like_secret", "too_deep", "bad_spec", "bad_validator", "validator_error", "not_found"]) {
    const x = rejectResult({ rejected_reason: r });
    assertEquals(x.status, 422, r);
    const b = x.body as Record<string, unknown>;
    assertEquals(b.error, r);
    assert(typeof b.message === "string" && /[一-鿿]/.test(b.message as string), r);
    assert(!("retry_after_seconds" in b), r);
  }
  const u = await quiet(() => Promise.resolve(rejectResult({ rejected_reason: "pg: secret table x" })));
  assertEquals(u.status, 422);
  assertEquals(JSON.stringify(u.body).includes("secret table"), false);
});

Deno.test("門鈴內容只有 kind 與 node，不含回報內容", () => {
  assertEquals(reportBellPayload("echo", "n1"), { kind: "echo", node: "n1" });
});

function mk(dbs: Record<string, unknown>) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rings: Array<[string, Record<string, unknown>]> = [];
  const bg: Promise<unknown>[] = [];
  const rpc: RpcFn = (fn, args) => { calls.push([fn, args]); const v = dbs[fn]; return Promise.resolve(v instanceof Error ? { data: null, error: v } : { data: v, error: null }); };
  const ring = (t: string, p: Record<string, unknown> = {}) => { rings.push([t, p]); return Promise.resolve(); };
  // 假的背景：收下 promise，測試用 flush 等它跑完（模擬 signal.background）
  const background = (p: Promise<unknown>) => { bg.push(p); };
  const flush = async () => { await Promise.all(bg); };
  return { calls, rings, flush, deps: { rpc, ring, background } };
}

Deno.test("report：壞輸入不打資料庫；節點取自 me.id；內容有變才敲讀者的門鈴（帶 kind／node、不帶內容）", async () => {
  const m = mk({ asn_relay_report: { ok: true, changed: true }, asn_relay_report_readers: { readers: ["b", "c", "b"], bell_topics: ["tb", "tc", "tb"] } });
  assertEquals((await handleReport(m.deps, { id: "ME" }, { kind: "BAD", payload: {} })).status, 400);
  assertEquals((await handleReport(m.deps, { id: "ME" }, { kind: "echo", payload: [] })).status, 400);
  assertEquals((await handleReport(m.deps, { id: "ME" }, { kind: "echo", payload: { t: "x".repeat(70000) } })).status, 413);
  assertEquals(m.calls.length, 0);
  const r = await handleReport(m.deps, { id: "ME" }, { kind: "echo", payload: { text: "秘密內容" }, node: "evil", p_node: "evil" });
  assertEquals(r, { status: 200, body: { ok: true, changed: true } });
  assertEquals(m.calls[0], ["asn_relay_report", { p_node: "ME", p_kind: "echo", p_payload: { text: "秘密內容" } }]);
  assertEquals(m.calls[1], ["asn_relay_report_readers", { p_node: "ME", p_kind: "echo" }]);
  await m.flush();
  assertEquals(m.rings, [["tb", { kind: "echo", node: "ME" }], ["tc", { kind: "echo", node: "ME" }]]);
  assertEquals(JSON.stringify(m.rings).includes("秘密"), false);
});

Deno.test("report：內容沒變（保活）不查讀者也不敲門鈴；讀者名單空也不出錯", async () => {
  const a = mk({ asn_relay_report: { ok: true, changed: false } });
  assertEquals(await handleReport(a.deps, { id: "ME" }, { kind: "echo", payload: {} }), { status: 200, body: { ok: true, changed: false } });
  await a.flush();
  assertEquals(a.calls.length, 1);
  assertEquals(a.rings, []);
  const b = mk({ asn_relay_report: { ok: true, changed: true }, asn_relay_report_readers: { readers: [], bell_topics: [] } });
  assertEquals((await handleReport(b.deps, { id: "ME" }, { kind: "echo", payload: {} })).status, 200);
  await b.flush();
  assertEquals(b.rings, []);
});

Deno.test("report：門鈴失敗或查讀者失敗都不讓 report 失敗", async () => {
  const m = mk({ asn_relay_report: { ok: true, changed: true }, asn_relay_report_readers: { readers: ["b"], bell_topics: ["tb"] } });
  const boom = { rpc: m.deps.rpc, ring: () => Promise.reject(new Error("net")), background: m.deps.background };
  assertEquals(await quiet(async () => { const r = await handleReport(boom, { id: "ME" }, { kind: "echo", payload: {} }); await m.flush(); return r; }), { status: 200, body: { ok: true, changed: true } });
  const m2 = mk({ asn_relay_report: { ok: true, changed: true }, asn_relay_report_readers: new Error("down") });
  assertEquals((await quiet(async () => { const r = await handleReport(m2.deps, { id: "ME" }, { kind: "echo", payload: {} }); await m2.flush(); return r; })).status, 200);
  const throwing = { rpc: ((fn: string) => fn === "asn_relay_report" ? Promise.resolve({ data: { ok: true, changed: true }, error: null }) : Promise.reject(new Error("x"))) as RpcFn, ring: m.deps.ring, background: m.deps.background };
  assertEquals((await quiet(async () => { const r = await handleReport(throwing, { id: "ME" }, { kind: "echo", payload: {} }); await m.flush(); return r; })).status, 200);
});

Deno.test("report：資料庫拒絕不敲門鈴；rate 回 429；後台沒套 migration 404；資料庫錯誤 500 不外洩原文", async () => {
  const a = mk({ asn_relay_report: { ok: false, rejected_reason: "rate", retry_after_seconds: 4 } });
  const r = await handleReport(a.deps, { id: "ME" }, { kind: "echo", payload: {} });
  assertEquals(r, { status: 429, body: { error: "rate", message: "回報太頻繁，請稍後再送。", retry_after_seconds: 4 } });
  assertEquals(a.calls.length, 1);
  const b = mk({ asn_relay_report: { ok: false, rejected_reason: "looks_like_email" } });
  assertEquals((await handleReport(b.deps, { id: "ME" }, { kind: "echo", payload: { e: "a@b.co" } })).status, 422);
  const c = mk({ asn_relay_report: { code: "PGRST202" } });
  c.deps.rpc = () => Promise.resolve({ data: null, error: { code: "PGRST202" } });
  assertEquals((await handleReport(c.deps, { id: "ME" }, { kind: "echo", payload: {} })).status, 404);
  const d = mk({});
  d.deps.rpc = () => Promise.resolve({ data: null, error: { message: "secret db text" } });
  const x = await quiet(() => handleReport(d.deps, { id: "ME" }, { kind: "echo", payload: {} }));
  assertEquals(x, { status: 500, body: { error: "internal" } });
  const e = mk({ asn_relay_report: {} });
  assertEquals((await quiet(() => handleReport(e.deps, { id: "ME" }, { kind: "echo", payload: {} }))).status, 500);
});

Deno.test("report_get：節點取自 me.id、nodes 去重；未知 kind 404；回 reports", async () => {
  const m = mk({ asn_relay_report_get: { ok: true, reports: [{ node: "a", kind: "echo", payload: { text: "1" } }] } });
  const r = await handleReportGet(m.deps, { id: "ME" }, { kind: "echo", nodes: ["a", "a", "b"], caller: "evil" });
  assertEquals(r, { status: 200, body: { ok: true, reports: [{ node: "a", kind: "echo", payload: { text: "1" } }] } });
  assertEquals(m.calls, [["asn_relay_report_get", { p_caller: "ME", p_kind: "echo", p_nodes: ["a", "b"] }]]);
  assertEquals((await handleReportGet(m.deps, { id: "ME" }, { kind: "echo", nodes: [] })).status, 400);
  assertEquals(m.calls.length, 1);
  const u = mk({ asn_relay_report_get: { ok: false, rejected_reason: "unknown_kind" } });
  assertEquals((await handleReportGet(u.deps, { id: "ME" }, { kind: "zzz", nodes: ["a"] })).status, 404);
  const o = mk({ asn_relay_report_get: { ok: false, rejected_reason: "weird" } });
  assertEquals((await quiet(() => handleReportGet(o.deps, { id: "ME" }, { kind: "zzz", nodes: ["a"] }))).status, 500);
});

Deno.test("網頁禁止：report／report_get 在禁止清單、不在放行清單", () => {
  for (const a of REPORT_ACTIONS) {
    assert(WEB_DENIED_ACTIONS.has(a), a);
    assert(!WEB_ALLOWED_ACTIONS.has(a), a);
  }
});

Deno.test("index.ts 接法：report／report_get 用節點金鑰的 me、門鈴走 ringReport、不讀 body 的節點代號", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  assert(/action === "report" && req\.method === "POST"/.test(src));
  assert(/action === "report_get" && req\.method === "POST"/.test(src));
  assert(/handleReport\(\{ rpc, ring, background: signal\.background \}, me,/.test(src));
  assert(/handleReportGet\(\{ rpc \}, me,/.test(src));
  // 既有 ring 仍是空 payload
  assert(/async function ring\(topic: string, payload: Record<string, unknown> = \{\}\)/.test(src), "ring 的預設 payload 仍是 {}");
  assert(!/ringReport/.test(src), "只有一套 ring");
});

Deno.test("report：回應不等門鈴——ring 永遠不完成，handler 照樣先回傳", async () => {
  const m = mk({ asn_relay_report: { ok: true, changed: true }, asn_relay_report_readers: { readers: ["b"], bell_topics: ["tb"] } });
  let rung = 0;
  const hang = { rpc: m.deps.rpc, ring: () => { rung++; return new Promise<void>(() => {}); }, background: m.deps.background };
  const r = await Promise.race([
    handleReport(hang, { id: "ME" }, { kind: "echo", payload: {} }),
    new Promise<string>((res) => setTimeout(() => res("等太久"), 1000)),
  ]);
  assertEquals(r, { status: 200, body: { ok: true, changed: true } });
  await new Promise((res) => setTimeout(res, 20));
  assertEquals(rung, 1, "門鈴有在背景開始發");
});

Deno.test("report：背景工作丟例外也不讓回應失敗", async () => {
  const m = mk({});
  const bg: Promise<unknown>[] = [];
  const deps = {
    rpc: ((fn: string) => fn === "asn_relay_report" ? Promise.resolve({ data: { ok: true, changed: true }, error: null }) : Promise.reject(new Error("boom"))) as RpcFn,
    ring: m.deps.ring,
    background: (p: Promise<unknown>) => { bg.push(p); },
  };
  const r = await quiet(async () => { const x = await handleReport(deps, { id: "ME" }, { kind: "echo", payload: {} }); await Promise.all(bg); return x; });
  assertEquals(r.status, 200);
});

Deno.test("report：讀者名單含寫入者自己時，Edge 層也不對寫入者響鈴（雙保險）", async () => {
  const m = mk({ asn_relay_report: { ok: true, changed: true }, asn_relay_report_readers: { readers: ["ME", "b"], bell_topics: ["t-me", "tb"] } });
  await handleReport(m.deps, { id: "ME" }, { kind: "echo", payload: {} });
  await m.flush();
  assertEquals(m.rings.map((x) => x[0]), ["tb"]);
});

Deno.test("report：名單與頻道數量對不上就一個都不敲（不錯位敲到別人）", async () => {
  const m = mk({ asn_relay_report: { ok: true, changed: true }, asn_relay_report_readers: { readers: ["b", "c"], bell_topics: ["tb"] } });
  const r = await quiet(async () => { const x = await handleReport(m.deps, { id: "ME" }, { kind: "echo", payload: {} }); await m.flush(); return x; });
  assertEquals(r.status, 200);
  assertEquals(m.rings, []);
});

Deno.test("report：讀者 210 個只敲前 200 個、每批 25 個（批間序列）、有 log 且只記數量", async () => {
  const ids = Array.from({ length: 210 }, (_, i) => "n" + String(i).padStart(3, "0"));
  const m = mk({ asn_relay_report: { ok: true, changed: true }, asn_relay_report_readers: { readers: ids, bell_topics: ids.map((i) => "t-" + i) } });
  let inflight = 0, maxInflight = 0;
  const topics: string[] = [];
  const deps = {
    rpc: m.deps.rpc,
    background: m.deps.background,
    ring: async (t: string) => {
      inflight++; maxInflight = Math.max(maxInflight, inflight); topics.push(t);
      await new Promise((res) => setTimeout(res, 1));
      inflight--;
    },
  };
  const logs: unknown[][] = [];
  const e = console.error;
  console.error = (...a: unknown[]) => { logs.push(a); };
  try { await handleReport(deps, { id: "ME" }, { kind: "echo", payload: {} }); await m.flush(); } finally { console.error = e; }
  assertEquals(topics.length, 200);
  assertEquals(topics[0], "t-n000");
  assertEquals(topics[199], "t-n199");
  assertEquals(maxInflight, 25, "每批 25 個、批間序列");
  assertEquals(logs.length, 1);
  const line = logs[0].join(" ");
  assert(line.includes("210") && line.includes("200"));
  assert(!line.includes("n000"), "log 不記節點代號");
  // 剛好 200 個不報
  const two = ids.slice(0, 200);
  const m2 = mk({ asn_relay_report: { ok: true, changed: true }, asn_relay_report_readers: { readers: two, bell_topics: two.map((i) => "t-" + i) } });
  const logs2: unknown[][] = [];
  console.error = (...a: unknown[]) => { logs2.push(a); };
  try { await handleReport(m2.deps, { id: "ME" }, { kind: "echo", payload: {} }); await m2.flush(); } finally { console.error = e; }
  assertEquals(m2.rings.length, 200);
  assertEquals(logs2.length, 0);
});

Deno.test("report：handler 不處理未授權，由 index.ts 在進入前回 401（順序守門）；節點只取自 me", async () => {
  const src = (await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  const iNoKey = src.indexOf('if (!web && !key) return json(401');
  const iBadKey = src.indexOf('if (!nodes || nodes.length === 0) return json(401');
  const iReport = src.indexOf('action === "report" && req.method === "POST"');
  const iGet = src.indexOf('action === "report_get" && req.method === "POST"');
  assert(iNoKey > 0 && iBadKey > iNoKey, "找得到前置 401");
  assert(iReport > iBadKey && iGet > iBadKey, "report／report_get 在沒金鑰與金鑰無效的 401 之後");
  const m = mk({ asn_relay_report: { ok: true, changed: false } });
  await handleReport(m.deps, { id: "FROM_KEY" }, { kind: "echo", payload: {}, node: "evil", p_node: "evil", me: { id: "evil" } });
  assertEquals(m.calls[0][1].p_node, "FROM_KEY");
});
