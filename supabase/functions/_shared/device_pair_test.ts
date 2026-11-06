import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DEVICE_PAIR_ACTIONS, DEVICE_PAIR_SIGNED_ACTIONS, type DevicePairDeps, handleDevicePairAction } from "./device_pair.ts";

const ID = "11111111-2222-3333-4444-555555555555";
const USER = "99999999-2222-3333-4444-555555555555";
const PUB = "a".repeat(43);
const SIG = "b".repeat(86);
const me = { id: "wrk9b2" };
const mk = (reply: Record<string, unknown> = {}, error: unknown = null) => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rung: string[] = [];
  const deps: DevicePairDeps = {
    rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve({ data: reply, error }); },
    ring: (t) => { rung.push(t); return Promise.resolve(); },
  };
  return { deps, calls, rung };
};

Deno.test("上傳公鑰：節點金鑰就可以，格式要對", async () => {
  const m = mk({ ok: true });
  assertEquals((await handleDevicePairAction(m.deps, me, "device_key_publish", { sign_pub: PUB, extra: "x" }, null)).status, 200);
  assertEquals(m.calls[0].args, { p_node: me.id, p_sign_pub: PUB });
  for (const bad of ["", "x", "a".repeat(44), "!".repeat(43), 5]) {
    assertEquals((await handleDevicePairAction(mk().deps, me, "device_key_publish", { sign_pub: bad }, null)).status, 400, String(bad));
  }
});

Deno.test("配對的動作沒簽章一律 403，也不碰資料庫", async () => {
  for (const a of DEVICE_PAIR_SIGNED_ACTIONS) {
    const m = mk();
    assertEquals((await handleDevicePairAction(m.deps, me, a, { id: ID, to_node: "x", from_pub: PUB, decision: "reject" }, null)).status, 403, a);
    assertEquals(m.calls.length, 0, a);
  }
});

Deno.test("發起：敲對方門鈴，回應不帶門鈴主題", async () => {
  const m = mk({ id: ID, to_pub: PUB, to_name: "家用機", expires_at: "t", bell_topic: "bell-x" });
  const r = await handleDevicePairAction(m.deps, me, "device_pair_start", { to_node: "phn7a1", from_pub: PUB }, USER);
  assertEquals(r.body, { id: ID, to_pub: PUB, to_name: "家用機", expires_at: "t" });
  assertEquals(m.rung, ["bell-x"]);
  assertEquals(m.calls[0].args, { p_actor: me.id, p_signed_user: USER, p_to_node: "phn7a1", p_from_pub: PUB, p_from_view_pub: null });
});

Deno.test("發起：帶 Hello 公鑰就一起轉送；格式或長度不對不碰資料庫", async () => {
  const VIEW = "A".repeat(360);
  const m = mk({ id: ID, to_pub: PUB, to_name: "家用機", expires_at: "t", bell_topic: "bell-x" });
  assertEquals((await handleDevicePairAction(m.deps, me, "device_pair_start", { to_node: "phn7a1", from_pub: PUB, from_view_pub: VIEW }, USER)).status, 200);
  assertEquals(m.calls[0].args.p_from_view_pub, VIEW);
  for (const v of ["A".repeat(199), "A".repeat(1401), "A".repeat(359) + "=", 42, ""]) {
    const bad = mk({ id: ID });
    assertEquals((await handleDevicePairAction(bad.deps, me, "device_pair_start", { to_node: "phn7a1", from_pub: PUB, from_view_pub: v }, USER)).status, 400, String(v).slice(0, 8));
    assertEquals(bad.calls.length, 0);
  }
});

Deno.test("發起：壞參數不碰資料庫；對方沒有金鑰說得清楚", async () => {
  for (const b of [{ to_node: "x" }, { from_pub: PUB }, { to_node: "../x", from_pub: PUB }, { to_node: "x", from_pub: "y" }]) {
    const m = mk();
    assertEquals((await handleDevicePairAction(m.deps, me, "device_pair_start", b, USER)).status, 400, JSON.stringify(b));
    assertEquals(m.calls.length, 0);
  }
  const r = await handleDevicePairAction(mk({ error: "no_key" }).deps, me, "device_pair_start", { to_node: "x", from_pub: PUB }, USER);
  assertEquals(r.status, 409);
  assertEquals(r.body.error, "no_key");
});

Deno.test("決定：確認一定要簽章；拒絕不帶簽章", async () => {
  const m = mk({ ok: true, status: "confirmed" });
  await handleDevicePairAction(m.deps, me, "device_pair_decide", { id: ID, decision: "confirm", sig: SIG }, USER);
  assertEquals(m.calls[0].args.p_sig, SIG);
  const n = mk({ ok: true, status: "rejected" });
  await handleDevicePairAction(n.deps, me, "device_pair_decide", { id: ID, decision: "reject", sig: SIG }, USER);
  assertEquals(n.calls[0].args.p_sig, null);
  for (const b of [{ id: ID, decision: "confirm" }, { id: ID, decision: "confirm", sig: "x" }, { id: "x", decision: "reject" }, { id: ID, decision: "maybe" }]) {
    assertEquals((await handleDevicePairAction(mk().deps, me, "device_pair_decide", b, USER)).status, 400, JSON.stringify(b));
  }
});

Deno.test("列出、收掉、錯誤、不認得的動作", async () => {
  assertEquals((await handleDevicePairAction(mk({ incoming: [1], outgoing: [2] }).deps, me, "device_pair_list", {}, USER)).body, { incoming: [1], outgoing: [2] });
  assertEquals((await handleDevicePairAction(mk({ ok: true }).deps, me, "device_pair_close", { id: ID }, USER)).status, 200);
  assertEquals((await handleDevicePairAction(mk().deps, me, "device_pair_close", { id: "x" }, USER)).status, 400);
  assertEquals((await handleDevicePairAction(mk({}, new Error("x")).deps, me, "device_pair_list", {}, USER)).body.error, "internal");
  assertEquals((await handleDevicePairAction(mk().deps, me, "device_pair_other", {}, USER)).status, 404);
  for (const a of DEVICE_PAIR_SIGNED_ACTIONS) assertEquals(DEVICE_PAIR_ACTIONS.has(a), true);
  assertEquals(DEVICE_PAIR_SIGNED_ACTIONS.has("device_key_publish"), false);
});
