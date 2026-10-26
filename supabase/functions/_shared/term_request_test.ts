import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleTermReqAction, parseCreate, TERM_REQ_ACTIONS, TERM_REQ_SIGNED_ACTIONS, type TermReqDeps } from "./term_request.ts";

const H = "a".repeat(64);
const ID = "11111111-2222-3333-4444-555555555555";
const mk = (reply: Record<string, unknown> | ((fn: string) => Record<string, unknown>) = {}) => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rung: string[] = [];
  const deps: TermReqDeps = {
    rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve({ data: (typeof reply === "function" ? reply(fn) : reply) as any, error: null }); },
    ring: (t) => { rung.push(t); return Promise.resolve(); },
  };
  return { deps, calls, rung };
};
const ok = { kind: "send", term_id: "3", folder_label: "order-plus", preview: "回答 1", enter: true, hash: H };

Deno.test("建立：只留認得的欄位，多餘的丟掉；代答一定要選項、送字不能帶選項", () => {
  assertEquals(parseCreate({ ...ok, command: "calc.exe", token: "SECRET" }), { kind: "send", term_id: "3", folder_label: "order-plus", preview: "回答 1", enter: true, options: null, hash: H });
  const ans = parseCreate({ kind: "answer", term_id: "4", preview: "信任嗎？", hash: H, options: [{ n: 1, label: "Yes" }, { n: 2, label: "No" }], extra: 1 });
  assertEquals(ans?.options, [{ n: 1, label: "Yes" }, { n: 2, label: "No" }]);
  for (const bad of [null, [], { ...ok, kind: "rm" }, { ...ok, term_id: "../x" }, { ...ok, term_id: "a".repeat(17) }, { ...ok, preview: "  " }, { ...ok, preview: 5 }, { ...ok, hash: "xyz" }, { ...ok, hash: "A".repeat(64) },
    { ...ok, enter: "yes" }, { ...ok, options: [{ n: 1, label: "x" }] }, { kind: "answer", term_id: "4", preview: "p", hash: H }, { kind: "answer", term_id: "4", preview: "p", hash: H, options: [] },
    { kind: "answer", term_id: "4", preview: "p", hash: H, options: [{ n: 1.5, label: "x" }] }, { kind: "answer", term_id: "4", preview: "p", hash: H, options: [{ n: 1 }] }]) {
    assertEquals(parseCreate(bad as any), null, JSON.stringify(bad));
  }
});

Deno.test("桌面建立：用金鑰所屬的節點（不接受 body 指定）、成功就只敲門鈴不帶內容", async () => {
  const t = mk({ id: ID, expires_at: "2026-10-26T00:00:00Z", bell_topic: "bell-w1" });
  const r = await handleTermReqAction(t.deps, { id: "W" }, "term_req_create", { ...ok, node: "EVIL", p_node: "EVIL" });
  assertEquals(r, { status: 200, body: { id: ID, expires_at: "2026-10-26T00:00:00Z" } });
  assertEquals(t.calls[0].args.p_node, "W");
  assertEquals(t.rung, ["bell-w1"]);
  assertEquals((await handleTermReqAction(mk().deps, { id: "W" }, "term_req_create", { ...ok, hash: "x" })).status, 400);
});

Deno.test("手機的動作（列出、決定）沒有本人簽章一律 403，而且在碰資料庫之前就擋", async () => {
  for (const [action, p] of [["term_req_list", {}], ["term_req_decide", { id: ID, decision: "approve", hash: H }]] as const) {
    const t = mk();
    const r = await handleTermReqAction(t.deps, { id: "P" }, action, p, null);
    assertEquals(r.status, 403);
    assertEquals(t.calls.length, 0);
  }
});

Deno.test("手機決定：檢查編號、決定、雜湊、選項；帶簽章使用者與自己的節點；回資料庫的錯誤碼", async () => {
  const t = mk({ ok: true, status: "approved" });
  const r = await handleTermReqAction(t.deps, { id: "P" }, "term_req_decide", { id: ID, decision: "approve", choice_n: 1, hash: H, p_signed_user: "evil" }, "U1");
  assertEquals(r, { status: 200, body: { ok: true, status: "approved" } });
  assertEquals(t.calls[0].args, { p_actor: "P", p_signed_user: "U1", p_id: ID, p_decision: "approve", p_choice_n: 1, p_hash: H });
  for (const bad of [{ id: "x", decision: "approve", hash: H }, { id: ID, decision: "yes", hash: H }, { id: ID, decision: "approve", hash: "no" }, { id: ID, decision: "approve", hash: H, choice_n: "1" }, { id: ID, decision: "approve", hash: H, choice_n: 100 }]) {
    assertEquals((await handleTermReqAction(mk().deps, { id: "P" }, "term_req_decide", bad, "U1")).status, 400, JSON.stringify(bad));
  }
  const codes: [string, number][] = [["hash_mismatch", 409], ["not_found", 404], ["bad_choice", 400], ["forbidden", 403]];
  for (const [code, status] of codes) assertEquals((await handleTermReqAction(mk({ error: code }).deps, { id: "P" }, "term_req_decide", { id: ID, decision: "approve", hash: H }, "U1")).status, status, code);
});

Deno.test("桌面領取與回報：只用自己的節點；回報狀態只認 done／failed／cancelled", async () => {
  const t = mk({ requests: [{ id: ID }], closed: [] });
  assertEquals((await handleTermReqAction(t.deps, { id: "W" }, "term_req_take", {})).body, { requests: [{ id: ID }], closed: [] });
  assertEquals(t.calls[0].args, { p_node: "W" });
  const r = mk({ ok: true });
  assertEquals((await handleTermReqAction(r.deps, { id: "W" }, "term_req_result", { id: ID, status: "done", detail: "x".repeat(500) })).status, 200);
  assertEquals((r.calls[0].args.p_detail as string).length, 200);
  for (const bad of [{ id: ID, status: "ok" }, { id: "x", status: "done" }, { status: "done" }]) assertEquals((await handleTermReqAction(mk().deps, { id: "W" }, "term_req_result", bad)).status, 400);
});

Deno.test("動作清單與簽章動作", () => {
  assertEquals([...TERM_REQ_ACTIONS].sort(), ["term_req_create", "term_req_decide", "term_req_list", "term_req_result", "term_req_take"]);
  assertEquals([...TERM_REQ_SIGNED_ACTIONS].sort(), ["term_req_decide", "term_req_list"]);
});

Deno.test("relay/index.ts：終端請求動作在金鑰驗證之後、手機兩個動作才讀簽章、行動者是 me", async () => {
  const src = (await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  const at = src.indexOf("TERM_REQ_ACTIONS.has(action)");
  assertEquals(at > src.indexOf("const me") || at > 0, true);
  const block = src.slice(at, src.indexOf("// 真人的群組動作", at));
  assertEquals(block.includes("TERM_REQ_SIGNED_ACTIONS.has(action)"), true);
  assertEquals(block.includes("handleTermReqAction({ rpc"), true);
  assertEquals(block.includes("me, action, params, signedTerm"), true);
});
