import { assert, assertEquals } from "jsr:@std/assert@1";
import { ACCOUNT_ACTIONS, type AccountDeps, handleAccountAction } from "./account.ts";
import { shouldRespond } from "./rooms.ts";

// AI 之間互相叫醒（migration 20261023190000_group_ai_wake_limit.sql）：
//  1. 叫醒判斷：AI 發的訊息明確點名另一個 AI，被點名的要被叫醒；超過上限（wake_ok=false）就不叫醒
//  2. account_settings 動作：讀／改 ai_wake_limit（0～20）
//  3. migration 靜態檢查（輪數的 SQL 實跑在 tests/group_ai_wake_sql.test.mjs）

Deno.test("shouldRespond：AI 發言點名另一個 AI 會叫醒；沒點名的 AI 訊息、點名別人、自己發的不叫醒", () => {
  const ai = (mentions: string[], extra: Record<string, unknown> = {}) => ({ from: "A~甲", trust: "member", from_kind: "ai", mentions, ...extra });
  assert(shouldRespond(ai(["B~乙"]), "B~乙"));
  assert(!shouldRespond(ai([]), "B~乙"), "AI 沒點名＝不叫醒（trust 不是 owner）");
  assert(!shouldRespond(ai(["C~丙"]), "B~乙"));
  assert(!shouldRespond(ai(["A~甲"]), "A~甲"), "自己發的不回");
  assert(shouldRespond(ai(["B~乙", "C~丙"]), "C~丙"));
});

Deno.test("shouldRespond：超過 AI 互相叫醒的上限（wake_ok=false）就不叫醒；其他人不受影響", () => {
  const m = { from: "A~甲", trust: "member", from_kind: "ai", mentions: ["B~乙"], wake_ok: false };
  assert(!shouldRespond(m, "B~乙"));
  assert(shouldRespond({ ...m, wake_ok: true }, "B~乙"));
  assert(shouldRespond({ from: "~u:1", trust: "owner", from_kind: "human", mentions: ["B~乙"], wake_ok: true }, "B~乙"));
});

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

Deno.test("account_settings：要登入憑證；沒帶 ai_wake_limit ＝讀", async () => {
  assert(ACCOUNT_ACTIONS.has("account_settings"));
  const t = deps({ ai_wake_limit: 5 });
  assertEquals((await handleAccountAction(t.d, "account_settings", null, null, {})).status, 401);
  assertEquals(t.calls.length, 0);
  const r = await handleAccountAction(t.d, "account_settings", `Bearer ${JWT}`, null, null);
  assertEquals(r, { status: 200, body: { ai_wake_limit: 5 } });
  assertEquals(t.calls[0], { fn: "asn_account_settings", args: { p_user: UID, p_ai_wake_limit: null } });
});

Deno.test("account_settings：帶 ai_wake_limit ＝改（0～20 整數）；其他一律 400 且不碰資料庫", async () => {
  const t = deps({ ai_wake_limit: 0 });
  const r = await handleAccountAction(t.d, "account_settings", `Bearer ${JWT}`, null, { ai_wake_limit: 0 });
  assertEquals(r.status, 200);
  assertEquals(t.calls[0].args, { p_user: UID, p_ai_wake_limit: 0 });
  for (const bad of [-1, 21, 2.5, "5", true, NaN]) {
    const x = await handleAccountAction(t.d, "account_settings", `Bearer ${JWT}`, null, { ai_wake_limit: bad });
    assertEquals(x.status, 400, String(bad));
  }
  assertEquals(t.calls.length, 1);
  const nf = deps({ error: "not_found" });
  assertEquals((await handleAccountAction(nf.d, "account_settings", `Bearer ${JWT}`, null, {})).status, 404);
});

Deno.test("migration：交易內、新函式只給 service_role、不刪東西；room_post 與 170100 的差異只有上限檢查", () => {
  const read = (f: string) => Deno.readTextFileSync(new URL(`../../migrations/${f}`, import.meta.url)).replace(/\r\n/g, "\n");
  const mig = read("20261023190000_group_ai_wake_limit.sql");
  const base = read("20261023170100_groups_p1a_rooms.sql");
  assert(/^begin;$/m.test(mig) && /^commit;$/m.test(mig));
  const code = mig.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert(!/drop table|drop column|delete from|truncate|drop function/i.test(code));
  assert(!/grant execute[^;]*to (anon|authenticated|public)/i.test(code));
  assert(mig.includes("revoke all on function public.asn_account_settings(uuid, integer) from public, anon, authenticated;"));
  assert(mig.includes("grant execute on function public.asn_account_settings(uuid, integer) to service_role;"));
  const fn = (sql: string) => {
    const i = sql.indexOf("create or replace function public.asn_relay_room_post(");
    return sql.slice(i, sql.indexOf("$function$;", sql.indexOf("AS $function$", i)) + 11);
  };
  const now = fn(mig);
  assert(now.includes("relay.room_ai_chain_blocked(p_room, v_key)"));
  assert(now.includes("p_signed_user uuid DEFAULT NULL::uuid)"), "簽章不變");
  // 拿掉新增的部分後，必須與 170100 的定義逐字相同
  const stripped = now
    .replace("  v_limited boolean := false;\n", "")
    .replace(/  v_human := [^\n]*\n  -- AI 發言[\s\S]*?  end if;\n/, "  v_sup := relay.room_wake_filter(p_room, v_st, v_rt, v_mentions);\n  v_human := v_trust = 'owner' or v_key = '~owner' or v_key like '~u:%';\n")
    .replace(",\n                            'wake_limited', v_limited);", ");");
  assertEquals(stripped, fn(base));
});
