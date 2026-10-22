import { assertEquals } from "jsr:@std/assert@1";
import {
  decidePartner, handlePartnerList, handlePartnerSucceed, handlePartnerSync, parsePartnerSync, parseSucceed, type PartnerRec,
  resolvePartner, type RpcFn,
} from "./partners.ts";

const S1 = "sess-0001-aaaa";
const S2 = "sess-0002-bbbb";
const rec = (id: string, name: string | null, session: string | null, extra: Partial<PartnerRec> = {}): PartnerRec => ({
  id, name, session, sessions: session ? [session] : [], oldNames: [], ...extra,
});

Deno.test("parsePartnerSync：整理名單；壞的 session／引擎／模型只當沒帶", () => {
  assertEquals(
    parsePartnerSync({ windows: [{ name: "甲", session_id: S1, engine: "claude", model: " opus " }, { name: "乙", session_id: "!!", engine: "Bad", model: "" }] }),
    [{ name: "甲", session_id: S1, engine: "claude", model: "opus" }, { name: "乙", session_id: null, engine: null, model: null }],
  );
  assertEquals(parsePartnerSync({ windows: [] }), []);
});

Deno.test("parsePartnerSync：名字不合格或不是陣列整份拒絕；多餘欄位丟掉（不收節點）", () => {
  for (const b of [null, "x", {}, { windows: "x" }, { windows: [null] }, { windows: [{}] }, { windows: [{ name: "" }] },
    { windows: [{ name: "字".repeat(61) }] }, { windows: [{ name: "a\nb" }] }, { windows: [{ name: 5 }] }]) {
    assertEquals(parsePartnerSync(b), null, JSON.stringify(b));
  }
  assertEquals(parsePartnerSync({ windows: Array.from({ length: 101 }, (_, i) => ({ name: "n" + i })) }), null);
  assertEquals(Object.keys(parsePartnerSync({ windows: [{ name: "甲", node: "別人", partner_id: "p_x" }] })![0]).sort(), ["engine", "model", "name", "session_id"]);
});

Deno.test("handlePartnerSync：節點取自 me.id；成功回 partners；格式錯 400 且不打資料庫", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc: RpcFn = (fn, args) => {
    calls.push([fn, args]);
    return Promise.resolve({ data: { partners: [{ name: "甲", partner_id: "p_" + "a".repeat(20) }] }, error: null });
  };
  const r = await handlePartnerSync({ rpc }, { id: "T" }, { node: "別人", windows: [{ name: "甲", session_id: S1 }] });
  assertEquals(r.status, 200);
  assertEquals(r.body, { ok: true, partners: [{ name: "甲", partner_id: "p_" + "a".repeat(20) }] });
  assertEquals(calls.length, 1);
  assertEquals(calls[0][0], "irori_relay_partner_sync");
  assertEquals(calls[0][1].p_node, "T");
  assertEquals(calls[0][1].p_windows, [{ name: "甲", session_id: S1, engine: null, model: null }]);
  const bad = await handlePartnerSync({ rpc }, { id: "T" }, { windows: [{ name: "" }] });
  assertEquals(bad.status, 400);
  assertEquals(calls.length, 1);
});

Deno.test("handlePartnerSync：資料庫還沒套用 migration＝404（橋靜默停用）；其他錯 500；函式回錯照轉", async () => {
  const mk = (data: unknown, error: unknown): RpcFn => () => Promise.resolve({ data, error });
  const ok = { windows: [{ name: "甲" }] };
  assertEquals((await handlePartnerSync({ rpc: mk(null, { code: "PGRST202", message: "x" }) }, { id: "T" }, ok)).status, 404);
  assertEquals((await handlePartnerSync({ rpc: mk(null, { code: "42883" }) }, { id: "T" }, ok)).status, 404);
  assertEquals((await handlePartnerSync({ rpc: mk(null, { message: "Could not find the function public.x" }) }, { id: "T" }, ok)).status, 404);
  const origErr = console.error;
  console.error = () => {};
  try {
    assertEquals((await handlePartnerSync({ rpc: mk(null, { code: "XX000", message: "boom" }) }, { id: "T" }, ok)).status, 500);
  } finally {
    console.error = origErr;
  }
  assertEquals((await handlePartnerSync({ rpc: mk({ error: "not_found" }, null) }, { id: "T" }, ok)).status, 404);
  assertEquals((await handlePartnerSync({ rpc: mk({ error: "bad_request" }, null) }, { id: "T" }, ok)).status, 400);
  assertEquals((await handlePartnerSync({ rpc: mk(null, null) }, { id: "T" }, ok)).body, { ok: true, partners: [] });
});

Deno.test("規則 1：同 session、名字變了 → 改名（記舊名）", () => {
  assertEquals(decidePartner([rec("p1", "甲", S1)], { name: "乙", session: S1 }), { kind: "rename", id: "p1", from: "甲" });
});

Deno.test("規則 2：名字相同、session 換了 → 同一位換 session（交接）；沒帶 session＝不動", () => {
  assertEquals(decidePartner([rec("p1", "甲", S1)], { name: "甲", session: S2 }), { kind: "handoff", id: "p1", from: S1 });
  assertEquals(decidePartner([rec("p1", "甲", S1)], { name: "甲", session: null }), { kind: "same" });
  assertEquals(decidePartner([rec("p1", "甲", null)], { name: "甲", session: S2 }), { kind: "handoff", id: "p1", from: null });
  assertEquals(decidePartner([rec("p1", "甲", S1)], { name: "甲", session: S1 }), { kind: "same" });
});

Deno.test("規則 3：名字和 session 都換 → 新夥伴", () => {
  assertEquals(decidePartner([rec("p1", "甲", S1)], { name: "乙", session: S2 }), { kind: "new" });
  assertEquals(decidePartner([], { name: "乙", session: null }), { kind: "new" });
});

Deno.test("規則 4：同一台兩個同名 → 擋（不處理）", () => {
  assertEquals(decidePartner([rec("p1", "甲", S1)], { name: "甲", session: S2 }, true), { kind: "blocked" });
});

Deno.test("舊 session 被接回來（名字也變）仍是同一位；session 優先於名字", () => {
  const p1 = rec("p1", "甲", S2, { sessions: [S1, S2] });
  assertEquals(decidePartner([p1], { name: "乙", session: S1 }), { kind: "rename", id: "p1", from: "甲" });
  assertEquals(decidePartner([p1], { name: "甲", session: S1 }), { kind: "handoff", id: "p1", from: S2 });
  // 名字屬於另一位、但 session 屬於 p2 → 以 session 為準（p2 改名成這個名字，p1 讓出）
  const p3 = rec("p3", "丙", S2);
  assertEquals(decidePartner([rec("p1", "甲", S1), p3], { name: "甲", session: S2 }), { kind: "rename", id: "p3", from: "丙" });
});

Deno.test("resolvePartner：目前名字優先；7 天內的舊名也解析得到；過期或別台解析不到", () => {
  const day = 86_400_000;
  const now = 100 * day;
  const p1 = rec("p1", "乙", S1, { oldNames: [{ name: "甲", at: now - 2 * day }, { name: "舊", at: now - 8 * day }] });
  const p2 = rec("p2", "甲", S2); // 後來有別人用了「甲」：目前名字優先
  assertEquals(resolvePartner([p1], "乙", now), "p1");
  assertEquals(resolvePartner([p1], "甲", now), "p1");
  assertEquals(resolvePartner([p1], "舊", now), null);
  assertEquals(resolvePartner([p1, p2], "甲", now), "p2");
  assertEquals(resolvePartner([p1], "沒這人", now), null);
  const p3 = rec("p3", "丙", null, { oldNames: [{ name: "甲", at: now - 1 * day }] });
  assertEquals(resolvePartner([p1, p3], "甲", now), "p3"); // 兩個舊名都在轉寄期：最近改的優先
});

Deno.test("relay/index.ts：partner_sync 排在金鑰驗證之後，節點取自金鑰（me），不收 body 的節點", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  const auth = src.indexOf("const me = nodes[0]");
  const act = src.indexOf('action === "partner_sync"');
  if (auth < 0 || act < auth) throw new Error("partner_sync 必須在金鑰驗證（const me）之後");
  const block = src.slice(act, src.indexOf('action === "leave"'));
  if (!block.includes("handlePartnerSync") || !block.includes("me,") || /\bb\??\.(node|id)\b/.test(block)) throw new Error("partner_sync 只能以 me 為節點");
});

// ---- 第二期（#153）：指定接班、夥伴清單 ----
const UID = "11111111-1111-1111-1111-111111111111";
const PID1 = "p_" + "ab".repeat(10);
const okUser = () => Promise.resolve({ id: UID, email: "a@b.c", name: "甲" });
const SIGNED = "Bearer tok-1234567890abcdef";
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const o = console.error;
  console.error = () => {};
  try { return await f(); } finally { console.error = o; }
};

Deno.test("parseSucceed：前任夥伴 ID、節點、名字都要合格；多餘欄位丟掉", () => {
  assertEquals(parseSucceed({ predecessor: PID1, node: "H", name: "小文", user: "evil", p_user: "x" }), { predecessor: PID1, node: "H", name: "小文" });
  for (const b of [null, "x", {}, { predecessor: "p_x", node: "H", name: "a" }, { predecessor: PID1, node: "a/b", name: "a" },
    { predecessor: PID1, node: "H", name: "" }, { predecessor: PID1, node: "H", name: "a\nb" }, { predecessor: PID1, node: "H", name: "字".repeat(61) },
    { predecessor: PID1, node: "H" }, { predecessor: 5, node: "H", name: "a" }]) {
    assertEquals(parseSucceed(b), null, JSON.stringify(b));
  }
});

Deno.test("handlePartnerSucceed：沒簽章 401 且不打資料庫；使用者取自簽章、呼叫節點取自金鑰（body 裡的使用者與呼叫節點被忽略）", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc: RpcFn = (fn, args) => { calls.push([fn, args]); return Promise.resolve({ data: { ok: true, partner_id: PID1 }, error: null }); };
  const deps = { rpc, verifyJwt: okUser };
  const body = { predecessor: PID1, node: "H2", name: "小文二號", p_user: "evil", p_caller: "evil", user: "evil" };
  for (const h of [null, "", "Bearer", "Basic abc"]) {
    assertEquals((await handlePartnerSucceed(deps, { id: "H" }, h, body)).status, 401, String(h));
  }
  assertEquals((await handlePartnerSucceed({ rpc, verifyJwt: () => Promise.resolve(null) }, { id: "H" }, SIGNED, body)).status, 401);
  assertEquals((await quiet(() => handlePartnerSucceed({ rpc, verifyJwt: () => Promise.reject(new Error("x")) }, { id: "H" }, SIGNED, body))).status, 401);
  assertEquals(calls.length, 0, "沒簽章不打資料庫");
  const r = await handlePartnerSucceed(deps, { id: "H" }, SIGNED, body);
  assertEquals(r, { status: 200, body: { ok: true } });
  assertEquals(calls, [["irori_relay_partner_succeed", { p_user: UID, p_caller: "H", p_predecessor: PID1, p_node: "H2", p_name: "小文二號" }]]);
  assertEquals((await handlePartnerSucceed(deps, { id: "H" }, SIGNED, { node: "H" })).status, 400);
});

Deno.test("handlePartnerSucceed：錯誤對應（forbidden 403／not_found 404／predecessor_live 409）；函式還沒套用 → 404", async () => {
  const mk = (data: unknown, error: unknown = null): RpcFn => () => Promise.resolve({ data, error });
  const run = (rpc: RpcFn) => handlePartnerSucceed({ rpc, verifyJwt: okUser }, { id: "H" }, SIGNED, { predecessor: PID1, node: "H", name: "a" });
  assertEquals((await run(mk({ error: "forbidden" }))).status, 403);
  assertEquals((await run(mk({ error: "not_found" }))).status, 404);
  assertEquals((await run(mk({ error: "predecessor_live" }))).status, 409);
  assertEquals((await run(mk({ error: "bad_request" }))).status, 400);
  assertEquals((await run(mk(null, { code: "PGRST202" }))).status, 404);
  assertEquals((await quiet(() => run(mk(null, { code: "XX000" })))).status, 500);
});

Deno.test("handlePartnerList：要簽章；呼叫節點取自金鑰；回清單", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc: RpcFn = (fn, args) => { calls.push([fn, args]); return Promise.resolve({ data: { partners: [{ partner_id: PID1, name: "小文" }] }, error: null }); };
  assertEquals((await handlePartnerList({ rpc, verifyJwt: okUser }, { id: "H" }, null)).status, 401);
  assertEquals(calls.length, 0);
  const r = await handlePartnerList({ rpc, verifyJwt: okUser }, { id: "H" }, SIGNED);
  assertEquals(r, { status: 200, body: { partners: [{ partner_id: PID1, name: "小文" }] } });
  assertEquals(calls, [["irori_relay_partner_list", { p_user: UID, p_caller: "H" }]]);
  const mk = (data: unknown, error: unknown = null): RpcFn => () => Promise.resolve({ data, error });
  assertEquals((await handlePartnerList({ rpc: mk({ error: "forbidden" }), verifyJwt: okUser }, { id: "H" }, SIGNED)).status, 403);
  assertEquals((await handlePartnerList({ rpc: mk(null, { code: "42883" }), verifyJwt: okUser }, { id: "H" }, SIGNED)).status, 404);
  assertEquals((await handlePartnerList({ rpc: mk({}), verifyJwt: okUser }, { id: "H" }, SIGNED)).body, { partners: [] });
});

Deno.test("relay/index.ts：partner_succeed／partner_list 排在金鑰驗證之後、走本人簽章標頭、節點取自金鑰（me）", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  const auth = src.indexOf("const me = nodes[0]");
  for (const [act, fn] of [["partner_succeed", "handlePartnerSucceed"], ["partner_list", "handlePartnerList"]]) {
    const at = src.indexOf(`action === "${act}"`);
    if (auth < 0 || at < auth) throw new Error(`${act} 必須在金鑰驗證（const me）之後`);
    const block = src.slice(at, src.indexOf("return json(r.status", at));
    if (!block.includes(fn) || !block.includes("me,") || !block.includes("SIGN_HEADER")) throw new Error(`${act} 要用 me 與 SIGN_HEADER`);
  }
});
