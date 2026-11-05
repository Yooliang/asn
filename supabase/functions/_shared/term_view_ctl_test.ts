import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleTermViewAction, TERM_VIEW_ACTIONS, TERM_VIEW_SIGNED_ACTIONS, type TermViewDeps } from "./term_view_ctl.ts";

const ID = "11111111-2222-3333-4444-555555555555";
const USER = "99999999-2222-3333-4444-555555555555";
const PUB = "a".repeat(43);
const T_SIG = "b".repeat(86);
const D_SIG = "c".repeat(342);
const me = { id: "wrk9b2" };
const mk = (reply: Record<string, unknown> = {}, error: unknown = null) => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rung: string[] = [];
  const deps: TermViewDeps = {
    rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve({ data: reply, error }); },
    ring: (t) => { rung.push(t); return Promise.resolve(); },
  };
  return { deps, calls, rung };
};
const start = { id: ID, to_node: "hom7a1", window_name: "小乙", d_eph_pub: PUB, d_sig: D_SIG, expires_at: "2026-11-05T10:00:00Z" };

Deno.test("看的那台的動作沒簽章一律 403，也不碰資料庫", async () => {
  for (const a of TERM_VIEW_SIGNED_ACTIONS) {
    const m = mk();
    assertEquals((await handleTermViewAction(m.deps, me, a, { ...start, state: "watching" }, null)).status, 403, a);
    assertEquals(m.calls.length, 0, a);
  }
});

Deno.test("發起：只傳認得的欄位，敲對方門鈴，回應不帶門鈴主題", async () => {
  const m = mk({ id: ID, topic: "tv_x", bell_topic: "bell-t" });
  const r = await handleTermViewAction(m.deps, me, "term_view_start", { ...start, text: "rm -rf /", keys: "x" }, USER);
  assertEquals(r.body, { id: ID, topic: "tv_x" });
  assertEquals(m.rung, ["bell-t"]);
  assertEquals(m.calls[0].args, { p_actor: me.id, p_signed_user: USER, p_id: ID, p_to_node: "hom7a1", p_window_name: "小乙", p_d_eph_pub: PUB, p_d_sig: D_SIG, p_expires_at: start.expires_at });
});

Deno.test("發起：壞參數不碰資料庫", async () => {
  for (const b of [{ id: "x" }, { to_node: "../x" }, { window_name: "" }, { window_name: "x".repeat(65) }, { d_eph_pub: "x" }, { d_sig: "x" }, { d_sig: "c".repeat(701) }, { expires_at: "明天" }, { expires_at: 5 }]) {
    const m = mk();
    assertEquals((await handleTermViewAction(m.deps, me, "term_view_start", { ...start, ...b }, USER)).status, 400, JSON.stringify(b));
    assertEquals(m.calls.length, 0);
  }
});

Deno.test("接受：節點金鑰就可以；T 的簽章只收 Ed25519 長度", async () => {
  const m = mk({ ok: true });
  assertEquals((await handleTermViewAction(m.deps, me, "term_view_accept", { id: ID, t_eph_pub: PUB, t_sig: T_SIG, status: "watching" }, null)).status, 200);
  assertEquals(m.calls[0].args, { p_node: me.id, p_id: ID, p_t_eph_pub: PUB, p_t_sig: T_SIG });
  for (const b of [{ id: "x", t_eph_pub: PUB, t_sig: T_SIG }, { id: ID, t_eph_pub: "x", t_sig: T_SIG }, { id: ID, t_eph_pub: PUB, t_sig: D_SIG }]) {
    assertEquals((await handleTermViewAction(mk().deps, me, "term_view_accept", b, null)).status, 400);
  }
});

Deno.test("結束：原因只能是固定值，自由文字進不去", async () => {
  for (const reason of ["target_ended", "rejected", "viewer_gone", "failed"]) {
    assertEquals((await handleTermViewAction(mk({ ok: true }).deps, me, "term_view_stop", { id: ID, reason }, null)).status, 200, reason);
  }
  for (const reason of ["viewer_ended", "expired", "隨便寫", null, undefined]) {
    assertEquals((await handleTermViewAction(mk().deps, me, "term_view_stop", { id: ID, reason }, null)).status, 400, String(reason));
  }
});

Deno.test("回報：狀態只能是固定值；沒有帶內容的路", async () => {
  const m = mk({ status: "watching", t_eph_pub: PUB, t_sig: T_SIG, expires_s: 5 });
  const r = await handleTermViewAction(m.deps, me, "term_view_report", { id: ID, state: "watching", text: "悄悄話", frame: "x" }, USER);
  assertEquals(r.body, { status: "watching", end_reason: null, t_eph_pub: PUB, t_sig: T_SIG, expires_s: 5 });
  assertEquals(m.calls[0].args, { p_actor: me.id, p_signed_user: USER, p_id: ID, p_state: "watching" });
  const q = mk({ status: "accepted" });
  await handleTermViewAction(q.deps, me, "term_view_report", { id: ID }, USER);
  assertEquals(q.calls[0].args.p_state, null, "只查");
  for (const state of ["requested", "accepted", "隨便寫", 5]) {
    assertEquals((await handleTermViewAction(mk().deps, me, "term_view_report", { id: ID, state }, USER)).status, 400, String(state));
  }
});

Deno.test("領取、錯誤、不認得的動作", async () => {
  assertEquals((await handleTermViewAction(mk({ requests: [1], active: [2] }).deps, me, "term_view_pending", {}, null)).body, { requests: [1], active: [2] });
  assertEquals((await handleTermViewAction(mk({ error: "busy" }).deps, me, "term_view_start", start, USER)).status, 409);
  assertEquals((await handleTermViewAction(mk({}, new Error("x")).deps, me, "term_view_pending", {}, null)).body.error, "internal");
  assertEquals((await handleTermViewAction(mk().deps, me, "term_view_send", {}, USER)).status, 404);
  for (const a of TERM_VIEW_SIGNED_ACTIONS) assertEquals(TERM_VIEW_ACTIONS.has(a), true);
});
