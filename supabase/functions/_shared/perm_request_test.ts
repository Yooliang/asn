import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handlePermReqAction, parseCreate, PERM_REQ_ACTIONS, PERM_REQ_SIGNED_ACTIONS, type PermReqDeps, TEXT_MAX } from "./perm_request.ts";

const H = "a".repeat(64);
const ID = "11111111-2222-3333-4444-555555555555";
const USER = "99999999-2222-3333-4444-555555555555";
const mk = (reply: Record<string, unknown> = {}, error: unknown = null) => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rung: string[] = [];
  const deps: PermReqDeps = {
    rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve({ data: reply, error }); },
    ring: (t) => { rung.push(t); return Promise.resolve(); },
  };
  return { deps, calls, rung };
};
const ok = { window_name: "小乙", prompt_text: "Do you want to proceed?\nrm x", complete: true, options: [{ n: 1, label: "Yes" }, { n: 3, label: "No" }], hash: H };
const me = { id: "wrk9b2" };

Deno.test("建立：只留認得的欄位，多餘的丟掉", () => {
  assertEquals(parseCreate({ ...ok, command: "calc.exe", token: "SECRET" }), ok);
});

Deno.test("建立：壞參數一律拒絕", () => {
  for (const bad of [
    null, [], { ...ok, window_name: "" }, { ...ok, window_name: "x".repeat(65) }, { ...ok, prompt_text: " " }, { ...ok, prompt_text: "x".repeat(TEXT_MAX + 1) },
    { ...ok, complete: "yes" }, { ...ok, hash: "abc" }, { ...ok, options: "1" }, { ...ok, options: [{ n: 0, label: "x" }] },
    { ...ok, options: [{ n: 10, label: "x" }] }, { ...ok, options: [{ n: 1.5, label: "x" }] }, { ...ok, options: [{ n: 1, label: " " }] },
    { ...ok, options: Array.from({ length: 10 }, (_, i) => ({ n: 1 + i % 9, label: "x" })) },
  ]) {
    assertEquals(parseCreate(bad as never), null, JSON.stringify(bad)?.slice(0, 80));
  }
});

Deno.test("建立：選項可以是空的（多選看得到不能按）", () => {
  assertEquals(parseCreate({ ...ok, options: [] })?.options, []);
});

Deno.test("建立：敲本人其他設備的門鈴，回應不帶內容", async () => {
  const m = mk({ id: ID, expires_at: "t", bell_topics: ["p1", "p2", 5] });
  const r = await handlePermReqAction(m.deps, me, "perm_req_create", ok, null);
  assertEquals(r.status, 200);
  assertEquals(r.body, { id: ID, expires_at: "t" });
  assertEquals(m.rung, ["p1", "p2"]);
  assertEquals(m.calls[0].fn, "asn_relay_perm_req_create");
  assertEquals(m.calls[0].args.p_node, me.id);
});

Deno.test("手機的動作沒簽章一律 403，也不碰資料庫", async () => {
  for (const a of PERM_REQ_SIGNED_ACTIONS) {
    const m = mk();
    const r = await handlePermReqAction(m.deps, me, a, { id: ID, choice_n: 1, hash: H }, null);
    assertEquals(r.status, 403, a);
    assertEquals(m.calls.length, 0, a);
  }
});

Deno.test("決定：只有編號、數字、雜湊；文字欄位不會傳下去", async () => {
  const m = mk({ ok: true, status: "decided" });
  const r = await handlePermReqAction(m.deps, me, "perm_req_decide", { id: ID, choice_n: 1, hash: H, text: "rm -rf /", keys: "y\n" }, USER);
  assertEquals(r.body, { ok: true, status: "decided" });
  assertEquals(m.calls[0].args, { p_actor: me.id, p_signed_user: USER, p_id: ID, p_choice_n: 1, p_hash: H });
});

Deno.test("決定：壞參數不碰資料庫", async () => {
  for (const b of [{ id: "x", choice_n: 1, hash: H }, { id: ID, choice_n: 0, hash: H }, { id: ID, choice_n: 10, hash: H }, { id: ID, choice_n: "1", hash: H }, { id: ID, hash: H }, { id: ID, choice_n: 1, hash: "x" }]) {
    const m = mk();
    assertEquals((await handlePermReqAction(m.deps, me, "perm_req_decide", b, USER)).status, 400, JSON.stringify(b));
    assertEquals(m.calls.length, 0);
  }
});

Deno.test("結果：只收三種狀態", async () => {
  for (const s of ["done", "failed", "cancelled"]) {
    assertEquals((await handlePermReqAction(mk({ ok: true }).deps, me, "perm_req_result", { id: ID, status: s }, null)).status, 200, s);
  }
  assertEquals((await handlePermReqAction(mk().deps, me, "perm_req_result", { id: ID, status: "decided" }, null)).status, 400);
});

Deno.test("領取、列出轉送欄位；資料庫回錯誤碼照實回", async () => {
  const t = await handlePermReqAction(mk({ requests: [1], closed: [2] }).deps, me, "perm_req_take", {}, null);
  assertEquals(t.body, { requests: [1], closed: [2] });
  const l = await handlePermReqAction(mk({ requests: [1], recent: [2] }).deps, me, "perm_req_list", {}, USER);
  assertEquals(l.body, { requests: [1], recent: [2] });
  assertEquals((await handlePermReqAction(mk({ error: "hash_mismatch" }).deps, me, "perm_req_decide", { id: ID, choice_n: 1, hash: H }, USER)).status, 409);
  assertEquals((await handlePermReqAction(mk({}, new Error("x")).deps, me, "perm_req_take", {}, null)).body.error, "internal");
});

Deno.test("動作清單：不認得的回 404；不和 term_req 重疊", async () => {
  assertEquals((await handlePermReqAction(mk().deps, me, "perm_req_send_text", {}, USER)).status, 404);
  for (const a of PERM_REQ_ACTIONS) assertEquals(a.startsWith("perm_req_"), true);
  for (const a of PERM_REQ_SIGNED_ACTIONS) assertEquals(PERM_REQ_ACTIONS.has(a), true);
});
