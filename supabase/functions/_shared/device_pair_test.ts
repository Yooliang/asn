import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DEVICE_PAIR_ACTIONS, DEVICE_PAIR_SIGNED_ACTIONS, handleDevicePairAction } from "./device_pair.ts";

const me = { id: "wrk9b2" };
const PUB = "a".repeat(43);
function mk(data: unknown = { ok: true }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rung: string[] = [];
  return {
    calls, rung,
    deps: { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: data as never, error: null }; }, ring: async (t: string) => { rung.push(t); } },
  };
}

Deno.test("動作只剩上傳公鑰和通知，都用節點金鑰（不再手動配對）", () => {
  assertEquals([...DEVICE_PAIR_ACTIONS].sort(), ["device_key_alert", "device_key_publish"]);
  assertEquals(DEVICE_PAIR_SIGNED_ACTIONS.size, 0);
});

Deno.test("上傳公鑰：格式要對", async () => {
  const m = mk();
  assertEquals((await handleDevicePairAction(m.deps, me, "device_key_publish", { sign_pub: PUB }, null)).status, 200);
  assertEquals(m.calls[0].args, { p_node: me.id, p_sign_pub: PUB });
  const bad = mk();
  assertEquals((await handleDevicePairAction(bad.deps, me, "device_key_publish", { sign_pub: "x" }, null)).status, 400);
  assertEquals(bad.calls.length, 0);
});

Deno.test("上傳公鑰：platform 選填，只收 desktop／android，其他值 400；沒帶時不傳 p_platform（舊版照常）", async () => {
  for (const platform of ["desktop", "android"]) {
    const m = mk();
    assertEquals((await handleDevicePairAction(m.deps, me, "device_key_publish", { sign_pub: PUB, platform }, null)).status, 200);
    assertEquals(m.calls[0].args, { p_node: me.id, p_sign_pub: PUB, p_platform: platform });
  }
  const none = mk();
  assertEquals((await handleDevicePairAction(none.deps, me, "device_key_publish", { sign_pub: PUB, platform: null }, null)).status, 200);
  assertEquals(none.calls[0].args, { p_node: me.id, p_sign_pub: PUB });
  for (const platform of ["ios", "", "Android", 7, {}]) {
    const bad = mk();
    assertEquals((await handleDevicePairAction(bad.deps, me, "device_key_publish", { sign_pub: PUB, platform }, null)).status, 400, JSON.stringify(platform));
    assertEquals(bad.calls.length, 0);
  }
});

Deno.test("通知：只收對方節點、種類、指紋；寄出後敲門鈴", async () => {
  const m = mk({ ok: true, notify: "sent", bell_topics: ["bell-a"] });
  const r = await handleDevicePairAction(m.deps, me, "device_key_alert", { peer: "hom7a1", kind: "first", fp: "0123456789abcdef", extra: "丟掉" }, null);
  assertEquals(r.body, { notify: "sent" });
  assertEquals(m.calls[0].args, { p_node: me.id, p_peer: "hom7a1", p_kind: "first", p_fp: "0123456789abcdef" });
  assertEquals(m.rung, ["bell-a"]);
  for (const b of [{ peer: "../x", kind: "first", fp: "0123456789abcdef" }, { peer: "x", kind: "other", fp: "0123456789abcdef" }, { peer: "x", kind: "changed", fp: "XYZ" }, { peer: "x", kind: "first" }]) {
    const bad = mk();
    assertEquals((await handleDevicePairAction(bad.deps, me, "device_key_alert", b, null)).status, 400, JSON.stringify(b));
    assertEquals(bad.calls.length, 0);
  }
});

Deno.test("舊的配對動作不在了", async () => {
  for (const a of ["device_pair_start", "device_pair_list", "device_pair_decide", "device_pair_close"]) {
    assertEquals((await handleDevicePairAction(mk().deps, me, a, {}, "u")).status, 404, a);
  }
});
