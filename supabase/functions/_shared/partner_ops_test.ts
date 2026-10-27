// 執行：SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno test -A supabase/functions/_shared/
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { LaunchDeps } from "./launch.ts";
import { handleNodePartnerOpAction, listPartnerOps, parsePartnerOp, partnerOpErrorText, requestPartnerOp, sanitizeResult } from "./partner_ops.ts";

type Call = { fn: string; args: Record<string, unknown> };
function fakeDeps(answer: (c: Call) => unknown = () => ({ id: "11111111-1111-1111-1111-111111111111", bell_topic: "bell-H" })) {
  const calls: Call[] = [];
  const rings: string[] = [];
  const deps: LaunchDeps = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      return Promise.resolve({ data: answer({ fn, args }), error: null });
    },
    ring: (t) => {
      rings.push(t);
      return Promise.resolve();
    },
  };
  return { deps, calls, rings };
}
const USER = "99999999-9999-9999-9999-999999999999";
const OK = { node: "H", name: "小文", op: "close" as const };
const ID = "22222222-2222-2222-2222-222222222222";

Deno.test("沒有本人簽章：下令與查進度都是 401，完全不打資料庫", async () => {
  const { deps, calls, rings } = fakeDeps();
  const a = await requestPartnerOp(deps, "P", OK, null);
  assertEquals([a.status, a.body.error], [401, "unauthorized"]);
  const b = await listPartnerOps(deps, "P", [ID], null);
  assertEquals(b.status, 401);
  const c = await handleNodePartnerOpAction(deps, { id: "P" }, "partner_op", OK, null);
  assertEquals(c.status, 401);
  assertEquals(calls, []);
  assertEquals(rings, []);
});

Deno.test("parsePartnerOp：只留該動作用得到的欄位；格式不對在進資料庫前擋下", () => {
  assertEquals(parsePartnerOp({ ...OK, new_name: "x", model: "y", note: "z" }), { ...OK, new_name: null, model: null, note: null });
  assertEquals(parsePartnerOp({ node: "H", name: "小文", op: "rename", new_name: "小文二號", model: "m" }), { node: "H", name: "小文", op: "rename", new_name: "小文二號", model: null, note: null });
  assertEquals(parsePartnerOp({ node: "H", name: "小文", op: "rename", new_name: "-rf" }), { error: "bad_name" });
  assertEquals(parsePartnerOp({ node: "H", name: "小文", op: "rename" }), { error: "bad_name" });
  assertEquals(parsePartnerOp({ node: "H", name: "小文", op: "model", model: "opus[1m]" }), { node: "H", name: "小文", op: "model", new_name: null, model: "opus[1m]", note: null });
  for (const bad of ["", "a b", "a;b", "a'b", "$(x)", "a/b", "x".repeat(61), "--help ", "a\nb"]) {
    assertEquals(parsePartnerOp({ node: "H", name: "小文", op: "model", model: bad }), { error: "bad_model" }, bad);
  }
  assertEquals(parsePartnerOp({ node: "H", name: "小文", op: "model" }), { error: "bad_model" });
  assertEquals(parsePartnerOp({ node: "H", name: "小文", op: "handover", note: "  接著做  " }), { node: "H", name: "小文", op: "handover", new_name: null, model: null, note: "接著做" });
  assertEquals(parsePartnerOp({ node: "H", name: "小文", op: "handover", note: "x".repeat(1001) }), { error: "bad_note" });
  assertEquals((parsePartnerOp({ node: "H", name: "小文", op: "handover", note: "x".repeat(1000) }) as { note: string }).note.length, 1000);
  assertEquals(parsePartnerOp({ node: "H", name: "小文", op: "handover", note: 5 }), { error: "bad_note" });
  assertEquals(parsePartnerOp({ node: "H", name: "Gemini", op: "restart", model: "x", note: "y", new_name: "z" }), { node: "H", name: "Gemini", op: "restart", new_name: null, model: null, note: null }, "重開：只收 node／name／op");
  assertEquals(parsePartnerOp({ node: "H", name: "Grok", op: "remove", model: "x", note: "y", new_name: "z" }), { node: "H", name: "Grok", op: "remove", new_name: null, model: null, note: null }, "移除（0.2 B3）：只收 node／name／op");
  assertEquals(parsePartnerOp({ node: "H", name: "小文", op: "resume", session_id: "../x", note: "z", new_name: "y" }), { node: "H", name: "小文", op: "resume", new_name: null, model: null, note: null }, "喚醒：只收 node／name／op，session 由後台從夥伴記錄查，不收用戶端的");
  assertEquals(parsePartnerOp({ ...OK, op: "kill" }), { error: "bad_request" });
  assertEquals(parsePartnerOp({ ...OK, node: "H;drop" }), { error: "bad_request" });
  assertEquals(parsePartnerOp({ ...OK, name: "" }), { error: "bad_request" });
  assertEquals(parsePartnerOp({ ...OK, name: "a\nb" }), { error: "bad_request" });
  assertEquals(parsePartnerOp([OK]), { error: "bad_request" });
});

Deno.test("requestPartnerOp：通過就呼叫資料庫函式（帶簽章者）並敲目標電腦門鈴；偽造的欄位不會帶進去", async () => {
  const { deps, calls, rings } = fakeDeps();
  const r = await requestPartnerOp(deps, "P", { ...OK, requested_by: "偽造", p_actor: "偽造" }, USER);
  assertEquals(r, { status: 200, body: { id: "11111111-1111-1111-1111-111111111111" } });
  assertEquals(calls, [{ fn: "asn_relay_partner_op", args: { p_actor: "P", p_signed_user: USER, p_node: "H", p_name: "小文", p_op: "close", p_new_name: null, p_model: null, p_note: null } }]);
  assertEquals(rings, ["bell-H"]);
});

Deno.test("requestPartnerOp：資料庫拒絕時對應狀態碼與中文說明，不敲門鈴", async () => {
  for (const [code, status] of [["forbidden", 403], ["protected", 403], ["not_found", 404], ["no_launcher", 409], ["busy", 409], ["name_taken", 409], ["rate_limited", 429], ["bad_name", 400], ["already_online", 409], ["no_session", 409], ["device_offline", 409], ["not_claude", 409]] as const) {
    const { deps, rings } = fakeDeps(() => ({ error: code }));
    const r = await requestPartnerOp(deps, "P", OK, USER);
    assertEquals([r.status, r.body.error], [status, code]);
    assert(typeof r.body.detail === "string" && r.body.detail.length > 0 && !/[A-Za-z]{4,}/.test(r.body.detail), `純中文：${r.body.detail}`);
    assertEquals(rings, []);
  }
  assertEquals(partnerOpErrorText("???"), "操作失敗");
  const { deps, calls } = fakeDeps();
  assertEquals((await requestPartnerOp(deps, "P", { ...OK, op: "kill" }, USER)).status, 400);
  assertEquals(calls, []);
});

Deno.test("listPartnerOps：ids 要是 1～20 個 uuid；回資料庫給的 ops", async () => {
  const { deps, calls } = fakeDeps(() => ({ ops: [{ id: ID }] }));
  assertEquals(await listPartnerOps(deps, "P", [ID], USER), { status: 200, body: { ops: [{ id: ID }] } });
  assertEquals(calls[0], { fn: "asn_relay_partner_ops", args: { p_actor: "P", p_signed_user: USER, p_ids: [ID] } });
  assertEquals((await listPartnerOps(deps, "P", `${ID},${ID}`, USER)).status, 200);
  for (const bad of [[], undefined, "nope", ["x"], Array(21).fill(ID), [5]]) assertEquals((await listPartnerOps(deps, "P", bad, USER)).status, 400);
  assertEquals((await listPartnerOps(deps, "P", Array(20).fill(ID), USER)).status, 200);
});

Deno.test("節點動作：pending／result 只帶自己的節點；result 狀態與 id 要對，超過 4KB 拒絕", async () => {
  const { deps, calls } = fakeDeps(({ fn }) => (fn === "asn_relay_partner_op_pending" ? [{ id: "x" }] : { ok: true }));
  assertEquals(await handleNodePartnerOpAction(deps, { id: "H" }, "partner_op_pending", { node: "W" }), { status: 200, body: { ops: [{ id: "x" }] } });
  const ok = await handleNodePartnerOpAction(deps, { id: "H" }, "partner_op_result", { id: ID, status: "ok", detail: "完成", result: { pid: 1 }, node: "W" });
  assertEquals(ok.status, 200);
  assertEquals((await handleNodePartnerOpAction(deps, { id: "H" }, "partner_op_result", { id: ID, status: "taken" })).status, 400);
  // 中途回報階段：只收固定格式，節點取自金鑰
  const stage = await handleNodePartnerOpAction(deps, { id: "H" }, "partner_op_progress", { id: ID, detail: "stage:handoff", node: "W" });
  assertEquals(stage, { status: 200, body: { ok: true } });
  assertEquals(calls[calls.length - 1], { fn: "asn_relay_partner_op_progress", args: { p_node: "H", p_id: ID, p_detail: "stage:handoff" } });
  for (const bad of ["請前任寫交接", "stage:", "stage:Handoff", "stage:a b", 5, null]) assertEquals((await handleNodePartnerOpAction(deps, { id: "H" }, "partner_op_progress", { id: ID, detail: bad })).status, 400, String(bad));
  assertEquals((await handleNodePartnerOpAction(deps, { id: "H" }, "partner_op_progress", { id: "nope", detail: "stage:x" })).status, 400);
  assertEquals((await handleNodePartnerOpAction(deps, { id: "H" }, "partner_op_result", { id: "nope", status: "ok" })).status, 400);
  const before = calls.length;
  const big = await handleNodePartnerOpAction(deps, { id: "H" }, "partner_op_result", { id: ID, status: "ok", result: { x: "字".repeat(1400) } });
  assertEquals([big.status, big.body.error], [400, "bad_request"]);
  assertEquals((await handleNodePartnerOpAction(deps, { id: "H" }, "partner_op_result", { id: ID, status: "ok", result: [1] })).status, 400);
  assertEquals(calls.length, before, "超過上限不碰資料庫");
  assertEquals(calls[0], { fn: "asn_relay_partner_op_pending", args: { p_node: "H" } });
  assertEquals(calls[1], { fn: "asn_relay_partner_op_result", args: { p_node: "H", p_id: ID, p_status: "ok", p_detail: "完成", p_result: { pid: 1 } } });
  assertEquals((await handleNodePartnerOpAction(deps, { id: "H" }, "nope", {})).status, 404);
});

Deno.test("sanitizeResult：空值放行、物件限 4096 位元組（以位元組不是字數算）", () => {
  assertEquals(sanitizeResult(undefined), null);
  assertEquals(sanitizeResult({ a: 1 }), { a: 1 });
  assertEquals(sanitizeResult({ a: "字".repeat(1400) }), { error: "bad_request" });   // 4200 位元組
  assertEquals(sanitizeResult("x"), { error: "bad_request" });
});

Deno.test("資料庫錯誤變 500，不洩漏細節", async () => {
  const deps: LaunchDeps = { rpc: () => Promise.resolve({ data: null, error: { message: "secret" } }), ring: () => Promise.resolve() };
  const r = await requestPartnerOp(deps, "P", OK, USER);
  assertEquals([r.status, r.body.error], [500, "internal"]);
  assert(!JSON.stringify(r.body).includes("secret"));
});
