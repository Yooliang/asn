// 手機（本人簽章）路徑：手機節點是 member，靠簽章證明「這個節點與租戶都是這個人的」才准看清單、送切換。
// 執行：cd supabase/functions && deno test -A _shared/account_switch_signed_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type AcctDeps, handleAcctAction } from "./account_switch.ts";

type Call = { fn: string; args: Record<string, unknown> };
function fakeDeps(answer: (c: Call) => unknown = () => ({ id: "11111111-1111-1111-1111-111111111111", bell_topic: "bell-W" })) {
  const calls: Call[] = [];
  const rings: string[] = [];
  const deps: AcctDeps = {
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
const ID = "11111111-1111-1111-1111-111111111111";
const SIGNED = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

Deno.test("acct_list／acct_switch：帶本人簽章就把 p_signed_user 傳給資料庫；沒簽章時完全不帶（行為與以前相同）", async () => {
  const a = fakeDeps(() => ({ node: "W", accounts: [], asn_online: true }));
  await handleAcctAction(a.deps, { id: "P" }, "acct_list", { node: "W" }, SIGNED);
  assertEquals(a.calls[0], { fn: "asn_relay_acct_list", args: { p_actor: "P", p_node: "W", p_signed_user: SIGNED } });
  const b = fakeDeps();
  const r = await handleAcctAction(b.deps, { id: "P" }, "acct_switch", { node: "W", vendor: "claude", email: "B@x.test" }, SIGNED);
  assertEquals(r.status, 200);
  assertEquals(b.calls[0], { fn: "asn_relay_acct_switch", args: { p_actor: "P", p_node: "W", p_vendor: "claude", p_email: "b@x.test", p_signed_user: SIGNED } });
  assertEquals(b.rings, ["bell-W"]);
  const c = fakeDeps();
  await handleAcctAction(c.deps, { id: "P" }, "acct_list", { node: "W" });
  assertEquals(Object.keys(c.calls[0].args).sort(), ["p_actor", "p_node"]);
});

Deno.test("acct_switch_status 不吃簽章（只看自己送的指令）", async () => {
  const s = fakeDeps(() => ({ switches: [] }));
  await handleAcctAction(s.deps, { id: "P" }, "acct_switch_status", { ids: [ID] }, SIGNED);
  assertEquals(s.calls[0], { fn: "asn_relay_acct_switch_status", args: { p_actor: "P", p_ids: [ID] } });
});

Deno.test("relay/index.ts：只有 acct_list／acct_switch 讀本人簽章標頭，且簽章只傳給 handleAcctAction", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  const at = src.indexOf("ACCT_ACTIONS.has(action)");
  const block = src.slice(at, at + 1200);
  assert(block.includes('action === "acct_list" || action === "acct_switch"'), "只有這兩個動作讀簽章");
  assert(block.includes("signedUserId("));
  assert(/handleAcctAction\([^;]*, me, action, params, signedAcct\)/.test(block));
});

Deno.test("migration 20261024130000：list／switch 多認本人簽章（asn_user_owns_node），預設值 null、只給 service_role", () => {
  const sql = Deno.readTextFileSync(new URL("../../migrations/20261024130000_acct_switch_signed.sql", import.meta.url));
  for (const fn of ["asn_relay_acct_list", "asn_relay_acct_switch"]) {
    const i = sql.indexOf(`function public.${fn}(`);
    assert(i >= 0, fn);
    const body = sql.slice(i, sql.indexOf("$function$;", sql.indexOf("as $function$", i)));
    assert(/p_signed_user uuid default null/.test(body), `${fn} 簽章參數要有預設值`);
    assert(body.includes("role = 'owner' or public.asn_user_owns_node(p_signed_user, p_actor)"), fn);
    assert(body.includes("tenant_id is not distinct from v_t"), `${fn} 要限定同租戶`);
  }
  assert(!/grant execute on function[^;]*\bto (anon|authenticated|public)\b/.test(sql));
  assertEquals((sql.match(/grant execute on function/g) ?? []).length, (sql.match(/revoke all on function/g) ?? []).length);
  assert(!/token|credential|secret|password/i.test(sql));
});
