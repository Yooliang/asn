// #500 拆項 3b：旗標 ASN_REQUIRE_SIGNED_ACCT 開啟而擋下 acct_list／acct_switch（403）時，記一筆 via=blocked＋實際簽章狀態。
// 執行：cd supabase/functions && deno test -A _shared/account_switch_observe_blocked_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type AcctDeps, handleAcctAction, SIGNED_ONLY_DETAIL } from "./account_switch.ts";
import type { SigState } from "./owner_sign.ts";

type Call = { fn: string; args: Record<string, unknown> };
const SIGNED = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const ID = "11111111-1111-1111-1111-111111111111";
function fakeDeps(owns: boolean | "error", observe: "ok" | "error" | "throw" = "ok") {
  const calls: Call[] = [];
  const deps: AcctDeps = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      if (fn === "asn_relay_auth_observe") {
        if (observe === "throw") return Promise.reject(new Error("boom"));
        return Promise.resolve(observe === "error" ? { data: null, error: { message: "x" } } : { data: null, error: null });
      }
      if (fn === "asn_user_owns_node") return Promise.resolve(owns === "error" ? { data: null, error: { message: "x" } } : { data: owns, error: null });
      if (fn === "asn_relay_acct_list") return Promise.resolve({ data: { node: "W", accounts: [], asn_online: true }, error: null });
      if (fn === "asn_relay_acct_switch") return Promise.resolve({ data: { id: ID, bell_topic: "bell-W" }, error: null });
      return Promise.resolve({ data: {}, error: null });
    },
    ring: () => Promise.resolve(),
  };
  return { deps, calls };
}
const PARAMS: Record<string, Record<string, unknown>> = { acct_list: { node: "W" }, acct_switch: { node: "W", vendor: "claude", email: "b@x.test" } };
const observed = (c: Call[]) => c.filter((x) => x.fn === "asn_relay_auth_observe");
const real = (c: Call[]) => c.filter((x) => x.fn === "asn_relay_acct_list" || x.fn === "asn_relay_acct_switch");

async function sha16(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

const CASES: [string, string | null, SigState, boolean, string][] = [
  ["旗標開＋無簽章", null, "absent", true, "absent"],
  ["旗標開＋簽章驗證失敗", null, "invalid", true, "invalid"],
  ["旗標開＋簽章有效但不是擁有者", SIGNED, "valid", false, "valid_not_owner"],
];
for (const action of ["acct_list", "acct_switch"]) {
  for (const [name, user, state, owns, sig] of CASES) {
    Deno.test(`${name}：${action} 回 403 並記一筆 blocked／${sig}（節點雜湊、不含使用者 id）`, async () => {
      const f = fakeDeps(owns);
      const r = await handleAcctAction(f.deps, { id: "P" }, action, PARAMS[action], user, state, true);
      assertEquals(r.status, 403);
      assertEquals(r.body.detail, SIGNED_ONLY_DETAIL);
      assertEquals(real(f.calls).length, 0);
      const o = observed(f.calls);
      assertEquals(o.length, 1);
      assertEquals(o[0].args, { p_action: action, p_via: "blocked", p_sig: sig, p_node_hash: await sha16("P") });
    });
  }
  for (const mode of ["error", "throw"] as const) {
    Deno.test(`記錄函式${mode === "throw" ? "丟錯" : "回錯"}：${action} 仍回 403`, async () => {
      const f = fakeDeps(false, mode);
      const r = await handleAcctAction(f.deps, { id: "P" }, action, PARAMS[action], SIGNED, "valid", true);
      assertEquals(r.status, 403);
      assertEquals(r.body.detail, SIGNED_ONLY_DETAIL);
      assertEquals(observed(f.calls).length, 1);
    });
  }
  Deno.test(`旗標關：${action} 與現況一致，不記 blocked（無簽章照常放行，只記 role／absent）`, async () => {
    const f = fakeDeps(false);
    const r = await handleAcctAction(f.deps, { id: "P" }, action, PARAMS[action]);
    assertEquals(r.status, 200);
    assert(!observed(f.calls).some((c) => c.args.p_via === "blocked"));
  });
  Deno.test(`旗標開＋查擁有者出錯（500）：${action} 不記 blocked`, async () => {
    const f = fakeDeps("error");
    const r = await handleAcctAction(f.deps, { id: "P" }, action, PARAMS[action], SIGNED, "valid", true);
    assertEquals(r.status, 500);
    assertEquals(observed(f.calls).length, 0);
  });
}
