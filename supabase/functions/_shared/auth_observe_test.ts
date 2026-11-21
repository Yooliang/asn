// #500 拆項 1：特權動作通過方式的記錄（只累加次數，不改授權與回應）。
// 執行：cd supabase/functions && deno test -A _shared/auth_observe_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleAcctAction } from "./account_switch.ts";
import { handleAttachAction } from "./attachments.ts";
import { nodeAction } from "./relay_ops.ts";
import { signedUserId, signedUserState } from "./owner_sign.ts";

type Call = { fn: string; args: Record<string, unknown> };
const USER = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const EMAIL = "someone@example.test";
const OBS = "asn_relay_auth_observe";
const FIELDS = ["p_action", "p_node_hash", "p_sig", "p_via"];

// observe：記錄函式的行為（ok／error／throw）；owns：asn_user_owns_node 的答案
function fake(opts: { owns?: boolean; observe?: "ok" | "error" | "throw" } = {}) {
  const calls: Call[] = [];
  const rpc = (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (fn === OBS) {
      if (opts.observe === "throw") throw new Error("boom");
      return Promise.resolve({ data: null, error: opts.observe === "error" ? { message: "x" } : null });
    }
    if (fn === "asn_user_owns_node") return Promise.resolve({ data: opts.owns ?? false, error: null });
    if (fn === "asn_relay_acct_list") return Promise.resolve({ data: { node: "W", accounts: [] }, error: null });
    if (fn === "asn_relay_acct_switch") return Promise.resolve({ data: { id: "i1", bell_topic: "b" }, error: null });
    if (fn === "asn_relay_invite") return Promise.resolve({ data: { expires_at: "t", prefix: "p" }, error: null });
    if (fn === "asn_relay_reissue") return Promise.resolve({ data: { expires_at: "t" }, error: null });
    if (fn === "asn_relay_attach_sweep") return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: null, error: null });
  };
  return { calls, rpc, ring: () => Promise.resolve() };
}
const obs = (calls: Call[]) => calls.filter((c) => c.fn === OBS);
const SW = { node: "W", vendor: "claude", email: EMAIL };

// 四種簽章狀態：只有 valid_owner 走 signed，其餘（沒帶、失敗、不是擁有者）都記 role
const CASES: Array<{ name: string; user: string | null; state: "absent" | "invalid" | "valid"; owns: boolean; via: string; sig: string }> = [
  { name: "沒帶標頭", user: null, state: "absent", owns: false, via: "role", sig: "absent" },
  { name: "驗證失敗", user: null, state: "invalid", owns: false, via: "role", sig: "invalid" },
  { name: "驗證通過但不是擁有者", user: USER, state: "valid", owns: false, via: "role", sig: "valid_not_owner" },
  { name: "驗證通過且是擁有者", user: USER, state: "valid", owns: true, via: "signed", sig: "valid_owner" },
];
for (const action of ["acct_list", "acct_switch"]) {
  for (const c of CASES) {
    Deno.test(`${action}：${c.name} → 記 ${c.via}／${c.sig}，只記一筆且欄位只有規定的四個`, async () => {
      const f = fake({ owns: c.owns });
      const r = await handleAcctAction(f, { id: "P" }, action, action === "acct_list" ? { node: "W" } : SW, c.user, c.state);
      assertEquals(r.status, 200);
      const o = obs(f.calls);
      assertEquals(o.length, 1);
      assertEquals(Object.keys(o[0].args).sort(), FIELDS);
      assertEquals([o[0].args.p_action, o[0].args.p_via, o[0].args.p_sig], [action, c.via, c.sig]);
      assert(/^[0-9a-f]{16}$/.test(String(o[0].args.p_node_hash)));
      const text = JSON.stringify(o[0].args);
      for (const bad of [EMAIL, USER, '"P"', "Bearer"]) assert(!text.includes(bad), `記錄參數不該含 ${bad}`);
      // 唯讀確認只在簽章驗過時問，且問的是這個呼叫端節點
      const owns = f.calls.filter((x) => x.fn === "asn_user_owns_node");
      assertEquals(owns.length, c.state === "valid" ? 1 : 0);
      if (owns.length) assertEquals(owns[0].args, { p_user: USER, p_node: "P" });
    });
  }
}

Deno.test("沒傳簽章狀態時：有使用者 id 當 valid、沒有當 absent（舊呼叫端照舊）", async () => {
  const f = fake({ owns: true });
  await handleAcctAction(f, { id: "P" }, "acct_list", { node: "W" }, USER);
  assertEquals(obs(f.calls)[0].args.p_sig, "valid_owner");
  const g = fake();
  await handleAcctAction(g, { id: "P" }, "acct_list", { node: "W" });
  assertEquals(obs(g.calls)[0].args.p_sig, "absent");
});

Deno.test("失敗的動作不記錄（只記成功回應）", async () => {
  const f = fake();
  const r = await handleAcctAction(f, { id: "P" }, "acct_list", { node: "bad node!" });
  assertEquals(r.status, 400);
  assertEquals(obs(f.calls).length, 0);
});

for (const mode of ["error", "throw"] as const) {
  Deno.test(`記錄函式${mode === "throw" ? "丟錯" : "回錯"}：acct_list／acct_switch 回應與沒記錄時完全相同`, async () => {
    for (const [action, params] of [["acct_list", { node: "W" }], ["acct_switch", SW]] as const) {
      const base = await handleAcctAction(fake({ owns: true }), { id: "P" }, action, params, USER, "valid");
      const bad = await handleAcctAction(fake({ owns: true, observe: mode }), { id: "P" }, action, params, USER, "valid");
      assertEquals(bad, base);
    }
  });
}

Deno.test("signedUserId 舊回傳值不變；signedUserState 回三種狀態", async () => {
  const jwt = "a".repeat(30);
  const good = (t: string) => Promise.resolve(t === jwt ? ({ id: USER } as never) : null);
  assertEquals(await signedUserId(good, undefined), null);
  assertEquals(await signedUserId(good, `Bearer ${jwt}`), USER);
  assertEquals(await signedUserId(good, `Bearer ${"b".repeat(30)}`), null);
  assertEquals(await signedUserId(() => Promise.reject(new Error("x")), `Bearer ${jwt}`), null);
  assertEquals(await signedUserId(() => Promise.resolve({ id: "not-a-uuid" } as never), `Bearer ${jwt}`), null);
  assertEquals(await signedUserState(good, undefined), { user: null, state: "absent" });
  assertEquals(await signedUserState(good, ""), { user: null, state: "absent" });
  assertEquals(await signedUserState(good, "garbage"), { user: null, state: "invalid" });
  assertEquals(await signedUserState(good, `Bearer ${"b".repeat(30)}`), { user: null, state: "invalid" });
  assertEquals(await signedUserState(() => Promise.reject(new Error("x")), `Bearer ${jwt}`), { user: null, state: "invalid" });
  assertEquals(await signedUserState(good, `Bearer ${jwt}`), { user: USER, state: "valid" });
});

// invite／reissue／attach_sweep：只有角色路徑，各記一筆 role／absent；回應與沒記錄時相同
async function run(name: string, f: ReturnType<typeof fake>) {
  if (name === "attach_sweep") {
    const deps = { rpc: f.rpc, storage: { remove: () => Promise.resolve(true) } as never };
    return await handleAttachAction(deps, { id: "H", role: "owner" }, "attach_sweep", {});
  }
  const r = await nodeAction({ rpc: f.rpc, ring: f.ring }, { tenant: "T", node: "H" }, name, name === "reissue" ? { id: "N1" } : {});
  // 邀請碼與重設碼是隨機產生的，比較時拿掉
  const body = { ...r.body };
  delete body.invite;
  delete body.code;
  return { status: r.status, body };
}
for (const name of ["invite", "reissue", "attach_sweep"]) {
  Deno.test(`${name}：記一筆 role／absent，欄位只有規定的四個；回應不變（含記錄函式丟錯）`, async () => {
    const f = fake();
    const base = await run(name, f);
    assertEquals(base.status, 200);
    const o = obs(f.calls);
    assertEquals(o.length, 1);
    assertEquals(Object.keys(o[0].args).sort(), FIELDS);
    assertEquals([o[0].args.p_action, o[0].args.p_via, o[0].args.p_sig], [name, "role", "absent"]);
    assert(!JSON.stringify(o[0].args).includes('"H"'));
    for (const mode of ["error", "throw"] as const) assertEquals(await run(name, fake({ observe: mode })), base);
  });
}

Deno.test("invite 被擋（forbidden）時不記錄、回應照舊", async () => {
  const f = fake();
  const rpc = (fn: string, a: Record<string, unknown>) =>
    fn === "asn_relay_invite" ? Promise.resolve({ data: { error: "forbidden" }, error: null }) : f.rpc(fn, a);
  const r = await nodeAction({ rpc, ring: f.ring }, { tenant: "T", node: "H" }, "invite", {});
  assertEquals([r.status, r.body], [403, { error: "forbidden" }]);
  assertEquals(obs(f.calls).length, 0);
});

Deno.test("relay／irori-relay 的 invite、reissue 入口都有記錄呼叫；relay 的帳號切換入口傳簽章狀態", () => {
  for (const f of ["../relay/index.ts", "../irori-relay/index.ts"]) {
    const src = Deno.readTextFileSync(new URL(f, import.meta.url)).replace(/\r\n/g, "\n");
    for (const a of ["invite", "reissue"]) {
      const i = src.indexOf(`action === "${a}" && req.method === "POST"`);
      assert(i >= 0, `${f} ${a}`);
      const blk = src.slice(i, src.indexOf("\n  }\n", i));
      assert(blk.includes("recordRoleOnly("), `${f} ${a} 要記錄`);
    }
  }
  const acct = Deno.readTextFileSync(new URL("../relay/index.ts", import.meta.url));
  assert(acct.includes("signedUserState(") && acct.includes("signedAcct, signedState.state)"));
});
