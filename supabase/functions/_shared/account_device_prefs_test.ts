import { assert, assertEquals } from "jsr:@std/assert@1";
import { ACCOUNT_ACTIONS, type AccountDeps, cleanDevicePrefs, handleAccountAction } from "./account.ts";

// 設備順序同步（migration 20261025010000_account_device_prefs.sql）：Edge 動作 account_device_prefs 與 migration 靜態檢查。
// SQL 實跑在 tests/account_device_prefs_sql.test.mjs。

const UID = "11111111-1111-1111-1111-111111111111";
const JWT = "j".repeat(40);
function deps(reply: unknown) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const d: AccountDeps = {
    verifyJwt: () => Promise.resolve({ id: UID, email: "a@b.c", name: "啟良" }),
    rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve({ data: reply, error: null }); },
    sha256Hex: () => Promise.resolve("h"),
    newSecrets: () => ({ key: "k", bellTopic: "t" }),
  };
  return { d, calls };
}
const GOOD = { order: ["a1", "b-2"], shown: ["c_3"], removed: [], rev: 1761350000000 };

Deno.test("account_device_prefs：要登入憑證；沒帶 prefs ＝讀（p_prefs 為 null）", async () => {
  assert(ACCOUNT_ACTIONS.has("account_device_prefs"));
  const t = deps({ prefs: null });
  assertEquals((await handleAccountAction(t.d, "account_device_prefs", null, null, {})).status, 401);
  assertEquals(t.calls.length, 0);
  const r = await handleAccountAction(t.d, "account_device_prefs", `Bearer ${JWT}`, null, null);
  assertEquals(r, { status: 200, body: { prefs: null } });
  assertEquals(t.calls[0], { fn: "asn_account_device_prefs", args: { p_user: UID, p_prefs: null } });
});

Deno.test("account_device_prefs：帶 prefs ＝寫；多餘欄位丟掉；stale 會帶回去；壞值一律 400 且不碰資料庫", async () => {
  const t = deps({ prefs: { ...GOOD, at: 5 } });
  const r = await handleAccountAction(t.d, "account_device_prefs", `Bearer ${JWT}`, null, { prefs: { ...GOOD, evil: 1 } });
  assertEquals(r.status, 200);
  assertEquals(t.calls[0].args, { p_user: UID, p_prefs: GOOD });
  const st = deps({ prefs: GOOD, stale: true });
  assertEquals((await handleAccountAction(st.d, "account_device_prefs", `Bearer ${JWT}`, null, { prefs: GOOD })).body, { prefs: GOOD, stale: true });
  const bads: unknown[] = [
    "x", [], { ...GOOD, order: "a" }, { ...GOOD, shown: [1] }, { ...GOOD, removed: ["a b"] }, { ...GOOD, order: ["a", "a"] },
    { ...GOOD, order: Array.from({ length: 201 }, (_, i) => `n${i}`) }, { ...GOOD, rev: -1 }, { ...GOOD, rev: 1.5 }, { ...GOOD, rev: "1" },
    { order: [], shown: [], removed: [] }, { ...GOOD, order: ["x".repeat(33)] },
  ];
  for (const b of bads) {
    assertEquals((await handleAccountAction(t.d, "account_device_prefs", `Bearer ${JWT}`, null, { prefs: b })).status, 400, JSON.stringify(b).slice(0, 60));
  }
  assertEquals(t.calls.length, 1);
});

Deno.test("account_device_prefs：後台回 rate_limited ＝ 429、not_found ＝ 404", async () => {
  assertEquals((await handleAccountAction(deps({ error: "rate_limited" }).d, "account_device_prefs", `Bearer ${JWT}`, null, { prefs: GOOD })).status, 429);
  assertEquals((await handleAccountAction(deps({ error: "not_found" }).d, "account_device_prefs", `Bearer ${JWT}`, null, {})).status, 404);
});

Deno.test("cleanDevicePrefs：只收合格的整份", () => {
  assertEquals(cleanDevicePrefs(GOOD), GOOD);
  assertEquals(cleanDevicePrefs({ ...GOOD, rev: 0 })?.rev, 0);
  assertEquals(cleanDevicePrefs(null), null);
});

Deno.test("migration：交易內、新函式只給 service_role、不刪東西、不改既有的 asn_account_settings", () => {
  const mig = Deno.readTextFileSync(new URL("../../migrations/20261025010000_account_device_prefs.sql", import.meta.url)).replace(/\r\n/g, "\n");
  assert(/^begin;$/m.test(mig) && /^commit;$/m.test(mig));
  const code = mig.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert(!/drop table|drop column|delete from|truncate|drop function/i.test(code));
  assert(!/grant execute[^;]*to (anon|authenticated|public)/i.test(code));
  assert(!code.includes("asn_account_settings"));
  assert(mig.includes("revoke all on function public.asn_account_device_prefs(uuid, jsonb) from public, anon, authenticated;"));
  assert(mig.includes("grant execute on function public.asn_account_device_prefs(uuid, jsonb) to service_role;"));
});
