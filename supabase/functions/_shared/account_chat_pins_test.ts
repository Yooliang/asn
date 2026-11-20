import { assert, assertEquals } from "jsr:@std/assert@1";
import { ACCOUNT_ACTIONS, type AccountDeps, cleanChatPins, handleAccountAction } from "./account.ts";

// 對話釘選同步（migration 20261116100000_account_chat_pins.sql）：Edge 動作 account_chat_pins 與 migration 靜態檢查。
// SQL 實跑在 tests/account_chat_pins_sql.test.mjs。

const UID = "11111111-1111-1111-1111-111111111111";
const JWT = "j".repeat(40);
function deps(reply: unknown) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const d: AccountDeps = {
    verifyJwt: () => Promise.resolve({ id: UID, email: "a@b.c", name: "擁有者" }),
    rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve({ data: reply, error: null }); },
    sha256Hex: () => Promise.resolve("h"),
    newSecrets: () => ({ key: "k", bellTopic: "t" }),
  };
  return { d, calls };
}
const GOOD = { pins: [{ id: "w1/財務 助理", at: 1761350000000 }, { id: "room:群 組", at: 1761350000001 }], unpinned: [{ id: "w1/w2", at: 1761350000002 }], rev: 3 };
const call = (d: AccountDeps, body: unknown, auth: string | null = `Bearer ${JWT}`) => handleAccountAction(d, "account_chat_pins", auth, null, body);

Deno.test("account_chat_pins：要登入憑證；沒帶 pins ＝讀（p_pins 為 null）", async () => {
  assert(ACCOUNT_ACTIONS.has("account_chat_pins"));
  const t = deps({ pins: null });
  assertEquals((await call(t.d, {}, null)).status, 401);
  assertEquals(t.calls.length, 0);
  assertEquals(await call(t.d, null), { status: 200, body: { pins: null } });
  assertEquals(t.calls[0], { fn: "asn_account_chat_pins", args: { p_user: UID, p_pins: null } });
});

Deno.test("account_chat_pins：帶 pins ＝寫；多餘欄位丟掉；stale 會帶回去", async () => {
  const t = deps({ pins: { ...GOOD, at: 5 } });
  const r = await call(t.d, { pins: { ...GOOD, evil: 1, pins: GOOD.pins.map((p) => ({ ...p, junk: 1 })) } });
  assertEquals(r.status, 200);
  assertEquals(t.calls[0].args, { p_user: UID, p_pins: GOOD });
  const st = deps({ pins: GOOD, stale: true });
  assertEquals((await call(st.d, { pins: GOOD })).body, { pins: GOOD, stale: true });
});

Deno.test("account_chat_pins：壞值一律 400 且不碰資料庫；中文與空白的 id 放行", async () => {
  const t = deps({ pins: GOOD });
  const e = (id: unknown, at: unknown = 1) => ({ ...GOOD, pins: [{ id, at }] });
  const bads: unknown[] = [
    "x", [], { ...GOOD, pins: "a" }, { ...GOOD, unpinned: {} }, { pins: GOOD.pins, rev: 1 }, { ...GOOD, pins: ["w1/a"] }, { ...GOOD, pins: [null] },
    e(""), e(5), e(undefined), e("a\u0000b"), e("a\nb"), e("a\u007fb"), e("x".repeat(201)), e("a", 0), e("a", -1), e("a", "1"), e("a", NaN), e("a", 2 ** 54),
    { ...GOOD, pins: Array.from({ length: 51 }, (_, i) => ({ id: `n${i}`, at: 1 })) },
    { ...GOOD, unpinned: Array.from({ length: 201 }, (_, i) => ({ id: `n${i}`, at: 1 })) },
    { ...GOOD, rev: -1 }, { ...GOOD, rev: 1.5 }, { ...GOOD, rev: "1" }, { pins: [], unpinned: [] },
  ];
  for (const b of bads) assertEquals((await call(t.d, { pins: b })).status, 400, JSON.stringify(b).slice(0, 60));
  assertEquals(t.calls.length, 0);
  assertEquals((await call(t.d, { pins: e("x".repeat(200)) })).status, 200);
  assertEquals((await call(t.d, { pins: { ...GOOD, pins: Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, at: 1 })) } })).status, 200);
});

Deno.test("account_chat_pins：後台回 rate_limited ＝ 429、too_large ＝ 413、not_found ＝ 404、bad_request ＝ 400；資料庫出錯 ＝ 500", async () => {
  assertEquals((await call(deps({ error: "rate_limited" }).d, { pins: GOOD })).status, 429);
  assertEquals((await call(deps({ error: "too_large" }).d, { pins: GOOD })).status, 413);
  assertEquals((await call(deps({ error: "not_found" }).d, {})).status, 404);
  assertEquals((await call(deps({ error: "bad_request", reason: "bad_rev" }).d, { pins: GOOD })).status, 400);
  const bad: AccountDeps = { ...deps(null).d, rpc: () => Promise.resolve({ data: null, error: { message: "boom" } }) };
  assertEquals((await call(bad, {})).status, 500);
});

Deno.test("cleanChatPins：只收合格的整份", () => {
  assertEquals(cleanChatPins(GOOD), GOOD);
  assertEquals(cleanChatPins({ ...GOOD, rev: 0 })?.rev, 0);
  assertEquals(cleanChatPins(null), null);
});

Deno.test("migration：交易內、新函式只給 service_role、不刪東西、不改 device_prefs 與 asn_account_settings", () => {
  const mig = Deno.readTextFileSync(new URL("../../migrations/20261116100000_account_chat_pins.sql", import.meta.url)).replace(/\r\n/g, "\n");
  assert(/^begin;$/m.test(mig) && /^commit;$/m.test(mig));
  const code = mig.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert(!/drop table|drop column|delete from|truncate|drop function/i.test(code));
  assert(!/grant execute[^;]*to (anon|authenticated|public)/i.test(code));
  assert(!code.includes("asn_account_settings") && !code.includes("asn_account_device_prefs"));
  assert(mig.includes("revoke all on function public.asn_account_chat_pins(uuid, jsonb) from public, anon, authenticated;"));
  assert(mig.includes("grant execute on function public.asn_account_chat_pins(uuid, jsonb) to service_role;"));
});
