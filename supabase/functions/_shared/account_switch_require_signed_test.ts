// #500 ③ 後台旗標 ASN_REQUIRE_SIGNED_ACCT：開啟後 acct_list／acct_switch 只認「驗證通過且 asn_user_owns_node 為真」的本人簽章（預設關）。
// 執行：cd supabase/functions && deno test -A _shared/account_switch_require_signed_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type AcctDeps, handleAcctAction, requireSignedFlag, SIGNED_ONLY_DETAIL } from "./account_switch.ts";

type Call = { fn: string; args: Record<string, unknown> };
const ID = "11111111-1111-1111-1111-111111111111";
const SIGNED = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
function fakeDeps(owns: boolean | "error") {
  const calls: Call[] = [];
  const deps: AcctDeps = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      if (fn === "asn_user_owns_node") return Promise.resolve(owns === "error" ? { data: null, error: { message: "x" } } : { data: owns, error: null });
      if (fn === "asn_relay_acct_list") return Promise.resolve({ data: { node: "W", accounts: [], asn_online: true }, error: null });
      if (fn === "asn_relay_acct_switch") return Promise.resolve({ data: { id: ID, bell_topic: "bell-W" }, error: null });
      return Promise.resolve({ data: { switches: [], requests: [], ok: true, count: 0 }, error: null });
    },
    ring: () => Promise.resolve(),
  };
  return { deps, calls };
}
const SW = { node: "W", vendor: "claude", email: "b@x.test" };
const PARAMS: Record<string, Record<string, unknown>> = { acct_list: { node: "W" }, acct_switch: SW };
const realCalls = (c: Call[]) => c.filter((x) => x.fn !== "asn_user_owns_node" && x.fn !== "asn_relay_auth_observe");

for (const action of ["acct_list", "acct_switch"]) {
  Deno.test(`旗標開＋無簽章：${action} 回 403＋白話 detail，不呼叫原資料庫函式（只記觀測）`, async () => {
    const f = fakeDeps(true);
    const r = await handleAcctAction(f.deps, { id: "P" }, action, PARAMS[action], null, "absent", true);
    assertEquals(r.status, 403);
    assertEquals(r.body.error, "forbidden");
    assertEquals(r.body.detail, SIGNED_ONLY_DETAIL);
    assertEquals(f.calls.map((c) => c.fn), ["asn_relay_auth_observe"]); // 只記觀測（blocked，#500 3b），沒有別的資料庫呼叫
  });
  Deno.test(`旗標開＋簽章驗證失敗（後台拿到 null）：${action} 回 403，不呼叫原 rpc`, async () => {
    const f = fakeDeps(true);
    const r = await handleAcctAction(f.deps, { id: "P" }, action, PARAMS[action], null, "absent", true);
    assertEquals(r.status, 403);
    assertEquals(realCalls(f.calls).length, 0);
  });
  Deno.test(`旗標開＋簽章有效但不是擁有者：${action} 回 403＋detail，不呼叫原 rpc`, async () => {
    const f = fakeDeps(false);
    const r = await handleAcctAction(f.deps, { id: "P" }, action, PARAMS[action], SIGNED, "valid", true);
    assertEquals(r.status, 403);
    assertEquals(r.body.detail, SIGNED_ONLY_DETAIL);
    assertEquals(f.calls.filter((c) => c.fn !== "asn_relay_auth_observe"), [{ fn: "asn_user_owns_node", args: { p_user: SIGNED, p_node: "P" } }]);
  });
  Deno.test(`旗標開＋查擁有者出錯：${action} 不放行（500），不呼叫原 rpc`, async () => {
    const f = fakeDeps("error");
    const r = await handleAcctAction(f.deps, { id: "P" }, action, PARAMS[action], SIGNED, "valid", true);
    assertEquals(r.status, 500);
    assertEquals(realCalls(f.calls).length, 0);
  });
  Deno.test(`旗標開＋擁有者簽章：${action} 通過並照常呼叫`, async () => {
    const f = fakeDeps(true);
    const r = await handleAcctAction(f.deps, { id: "P" }, action, PARAMS[action], SIGNED, "valid", true);
    assertEquals(r.status, 200);
    const real = realCalls(f.calls);
    assertEquals(real.length, 1);
    assertEquals(real[0].fn, `asn_relay_${action}`);
    assertEquals(real[0].args.p_signed_user, SIGNED);
  });
  Deno.test(`旗標關（預設）：${action} 與現況一樣，不查擁有者、無簽章照常呼叫`, async () => {
    const f = fakeDeps(false);
    const r = await handleAcctAction(f.deps, { id: "P" }, action, PARAMS[action]);
    assertEquals(r.status, 200);
    assertEquals(realCalls(f.calls).length, 1);
    assert(!f.calls.some((c) => c.fn === "asn_user_owns_node"));
    assertEquals(f.calls[0].fn, `asn_relay_${action}`);
    assert(!("p_signed_user" in f.calls[0].args));
  });
}

Deno.test("旗標開：其他五個帳號動作不受影響（沒簽章照常呼叫）", async () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["acct_switch_status", { ids: [ID] }, "asn_relay_acct_switch_status"],
    ["acct_report", { accounts: [{ vendor: "claude", email: "a@x.test", plan: "pro", current: true }] }, "asn_relay_acct_report"],
    ["acct_switch_pending", {}, "asn_relay_acct_switch_pending"],
    ["acct_switch_result", { id: ID, status: "ok" }, "asn_relay_acct_switch_result"],
  ];
  for (const [action, params, fn] of cases) {
    const f = fakeDeps(false);
    const r = await handleAcctAction(f.deps, { id: "P" }, action, params, null, "absent", true);
    assert(r.status !== 403, action);
    assertEquals(f.calls[0].fn, fn);
    assert(!f.calls.some((c) => c.fn === "asn_user_owns_node"), action);
  }
  // acct_roster 本來就只認簽章：沒簽章 403（與旗標無關，一字不差）
  const g = fakeDeps(true);
  const r = await handleAcctAction(g.deps, { id: "P" }, "acct_roster", {}, null, "absent", true);
  assertEquals(r.status, 403);
  assertEquals(r.body.detail, "只有使用者本人（擁有者設備）能遠端切換帳號");
});

Deno.test("旗標值解析：只有恰為 1 才算開", () => {
  const table: [string | null | undefined, boolean][] = [
    [undefined, false], [null, false], ["", false], ["0", false], ["false", false], ["true", false], ["yes", false], ["on", false],
    [" 1 ", false], ["1 ", false], ["01", false], ["1", true],
  ];
  for (const [v, want] of table) assertEquals(requireSignedFlag(v), want, JSON.stringify(v));
});

Deno.test("relay/index.ts：旗標由環境變數讀入並只傳給 handleAcctAction，簽章那一行形式不變", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  assert(src.includes('requireSignedFlag(Deno.env.get("ASN_REQUIRE_SIGNED_ACCT"))'));
  assertEquals(src.split("ASN_REQUIRE_SIGNED_ACCT").length - 1, 1);
  assert(src.includes('const signedAcct = (action === "acct_list" || action === "acct_switch" || action === "acct_roster") ? await signedUserId('));
});

// 觀測（#2067，recordAcct）：通過的記 signed／valid_owner；被擋下的另由 #500 3b 記 blocked（見 account_switch_observe_blocked_test.ts）
Deno.test("擁有者簽章通過：記一筆 signed／valid_owner", async () => {
  const g = fakeDeps(true);
  const r = await handleAcctAction(g.deps, { id: "P" }, "acct_switch", SW, SIGNED, "valid", true);
  assertEquals(r.status, 200);
  const obs = g.calls.filter((c) => c.fn === "asn_relay_auth_observe");
  assertEquals(obs.length, 1);
  assertEquals(obs[0].args.p_via, "signed");
});
