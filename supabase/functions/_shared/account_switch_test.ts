// 執行：cd supabase/functions && deno test -A _shared/
import { assert, assertEquals } from "jsr:@std/assert@1";
import { ACCT_ACTIONS, type AcctDeps, cleanEmail, handleAcctAction, parseReport, parseSwitch } from "./account_switch.ts";

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

Deno.test("email 整理：小寫去空白；路徑字元、空白、多個 @ 一律不合格", () => {
  assertEquals(cleanEmail("  Foo.Bar+x@Example.COM "), "foo.bar+x@example.com");
  for (const bad of ["", "a", "a@", "@b", "a@b@c", "a b@c", "a/b@c", "a\\b@c", "a:b@c", "../x@y", "a\n@b", 3, null, `${"x".repeat(120)}@y`]) {
    assertEquals(cleanEmail(bad), null, String(bad));
  }
});

Deno.test("parseReport：每筆只留四個欄位，權杖類的多餘欄位丟掉；任何一筆不合格整份退回", () => {
  const r = parseReport({ accounts: [{ vendor: "claude", email: "A@x.test", plan: "max", current: true, accessToken: "SECRET", org: "O" }, { vendor: "claude", email: "b@x.test" }] });
  assertEquals(r, [
    { vendor: "claude", email: "a@x.test", plan: "max", current: true },
    { vendor: "claude", email: "b@x.test", plan: "", current: false },
  ]);
  assert(!JSON.stringify(r).includes("SECRET"));
  assertEquals(parseReport({ accounts: [{ vendor: "grok", email: "G@x.test", plan: "", current: true, refresh_token: "SECRET" }] }), [{ vendor: "grok", email: "g@x.test", plan: "", current: true }]);
  assertEquals(parseReport({ accounts: [{ vendor: "codex", email: "C@x.test", plan: "plus", current: true, id_token: "SECRET" }] }), [{ vendor: "codex", email: "c@x.test", plan: "plus", current: true }]);
  assertEquals(parseReport({ accounts: [] }), []);
  for (const bad of [null, {}, { accounts: "x" }, { accounts: [{ vendor: "gemini", email: "a@x.test" }] }, { accounts: [{ vendor: "claude", email: "bad" }] },
    { accounts: [{ vendor: "claude", email: "a@x.test", plan: 5 }] }, { accounts: [{ vendor: "claude", email: "a@x.test", plan: "x\n" }] },
    { accounts: [{ vendor: "claude", email: "a@x.test", current: "yes" }] }, { accounts: Array.from({ length: 21 }, () => ({ vendor: "claude", email: "a@x.test" })) }]) {
    assertEquals(parseReport(bad), null, JSON.stringify(bad));
  }
});

Deno.test("parseSwitch：指令只帶節點與 email；多餘欄位（憑證、指令）丟掉", () => {
  assertEquals(parseSwitch({ node: "W", vendor: "claude", email: "B@X.test", token: "SECRET", command: "calc.exe" }), { node: "W", vendor: "claude", email: "b@x.test" });
  assertEquals(parseSwitch({ node: "W;x", vendor: "claude", email: "b@x.test" }), { error: "bad_request" });
  assertEquals(parseSwitch({ node: "W", vendor: "codex", email: "b@x.test" }), { error: "bad_vendor" });
  assertEquals(parseSwitch({ node: "W", vendor: "gemini", email: "b@x.test" }), { error: "bad_vendor" });
  assertEquals(parseSwitch({ node: "W", vendor: "grok", email: "B@X.test", token: "SECRET" }), { node: "W", vendor: "grok", email: "b@x.test" });
  assertEquals(parseSwitch({ node: "W", vendor: "claude", email: "../x" }), { error: "bad_email" });
  assertEquals(parseSwitch([1]), { error: "bad_request" });
});

Deno.test("acct_report：節點取自金鑰（body 指定的節點被忽略）", async () => {
  const { deps, calls } = fakeDeps(() => ({ ok: true, count: 1 }));
  const r = await handleAcctAction(deps, { id: "W" }, "acct_report", { node: "H", accounts: [{ vendor: "claude", email: "a@x.test", plan: "max", current: true }] });
  assertEquals(r, { status: 200, body: { ok: true, count: 1 } });
  assertEquals(calls, [{ fn: "asn_relay_acct_report", args: { p_node: "W", p_accounts: [{ vendor: "claude", email: "a@x.test", plan: "max", current: true }] } }]);
  const bad = fakeDeps();
  assertEquals((await handleAcctAction(bad.deps, { id: "W" }, "acct_report", { accounts: [{ vendor: "claude", email: "x" }] })).status, 400);
  assertEquals(bad.calls, [], "格式不對不碰資料庫");
});

Deno.test("acct_switch：actor 由金鑰決定；通過就敲對方門鈴、回指令編號", async () => {
  const { deps, calls, rings } = fakeDeps();
  const r = await handleAcctAction(deps, { id: "H" }, "acct_switch", { node: "W", vendor: "claude", email: "B@x.test", requested_by: "偽造" });
  assertEquals(r, { status: 200, body: { id: ID } });
  assertEquals(calls, [{ fn: "asn_relay_acct_switch", args: { p_actor: "H", p_node: "W", p_vendor: "claude", p_email: "b@x.test" } }]);
  assertEquals(rings, ["bell-W"]);
});

Deno.test("acct_switch：資料庫拒絕時對應狀態碼與中文原因，不敲門鈴；非擁有者一律 403", async () => {
  for (const [code, status] of [["forbidden", 403], ["not_found", 404], ["asn_offline", 409], ["unknown_account", 409], ["busy", 409], ["rate_limited", 429], ["bad_email", 400]] as const) {
    const { deps, rings } = fakeDeps(() => ({ error: code }));
    const r = await handleAcctAction(deps, { id: "G" }, "acct_switch", { node: "W", vendor: "claude", email: "b@x.test" });
    assertEquals([r.status, r.body.error], [status, code]);
    assert(typeof r.body.detail === "string" && r.body.detail.length > 0);
    assertEquals(rings, []);
  }
  const { deps, calls } = fakeDeps();
  assertEquals((await handleAcctAction(deps, { id: "H" }, "acct_switch", { node: "W", vendor: "claude", email: "nope" })).status, 400);
  assertEquals(calls, []);
});

Deno.test("acct_list／acct_switch_status／pending／result 的參數檢查與轉送", async () => {
  const a = fakeDeps(() => ({ node: "W", accounts: [], reported_at: null, asn_online: false }));
  assertEquals((await handleAcctAction(a.deps, { id: "H" }, "acct_list", { node: "W" })).status, 200);
  assertEquals(a.calls[0], { fn: "asn_relay_acct_list", args: { p_actor: "H", p_node: "W" } });
  assertEquals((await handleAcctAction(a.deps, { id: "H" }, "acct_list", { node: "W W" })).status, 400);

  const s = fakeDeps(() => ({ switches: [] }));
  assertEquals((await handleAcctAction(s.deps, { id: "H" }, "acct_switch_status", { ids: ID })).status, 200);
  assertEquals(s.calls[0].args, { p_actor: "H", p_ids: [ID] });
  assertEquals((await handleAcctAction(s.deps, { id: "H" }, "acct_switch_status", { ids: ["x"] })).status, 400);
  assertEquals((await handleAcctAction(s.deps, { id: "H" }, "acct_switch_status", { ids: [] })).status, 400);

  const p = fakeDeps(() => ({ requests: [{ id: ID, requested_by: "H", vendor: "claude", email: "b@x.test" }] }));
  const pr = await handleAcctAction(p.deps, { id: "W" }, "acct_switch_pending", {});
  assertEquals(pr.body.requests.length, 1);
  assertEquals(p.calls[0], { fn: "asn_relay_acct_switch_pending", args: { p_node: "W" } });

  const res = fakeDeps(() => ({ ok: true }));
  assertEquals((await handleAcctAction(res.deps, { id: "W" }, "acct_switch_result", { id: ID, status: "ok", detail: "x".repeat(900) })).status, 200);
  assertEquals((res.calls[0].args.p_detail as string).length, 300);
  for (const bad of [{ id: "x", status: "ok" }, { id: ID, status: "pending" }, { id: ID, status: "taken" }, {}]) {
    assertEquals((await handleAcctAction(res.deps, { id: "W" }, "acct_switch_result", bad)).status, 400);
  }
});

// relay/index.ts 是 Deno.serve 入口、無法直接 import：守「帳號動作在金鑰驗證之後、行動者只取自金鑰（me）」
Deno.test("relay/index.ts：帳號動作排在金鑰驗證之後，行動者是 me（不接受 body 指定）", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  const auth = src.indexOf("asn_relay_auth");
  const at = src.indexOf("ACCT_ACTIONS.has(action)");
  assert(auth > 0 && at > auth, "帳號動作要在金鑰驗證之後");
  const block = src.slice(at, at + 1200);
  assert(block.includes("handleAcctAction(") && block.includes(", me, action"));
  // 資料庫函式：擁有者判定與 launch 同一套，且所有函式只給 service_role
  const sql = Deno.readTextFileSync(new URL("../../migrations/20261021040000_asn_account_switch.sql", import.meta.url));
  assertEquals((sql.match(/role = 'owner' and status = 'active'/g) ?? []).length, 2, "acct_list 與 acct_switch 都要驗擁有者");
  assertEquals((sql.match(/grant execute on function/g) ?? []).length, (sql.match(/revoke all on function/g) ?? []).length);
  assert(!/grant execute on function[^;]*\bto (anon|authenticated|public)\b/.test(sql));
});

Deno.test("動作清單與分派一致", () => {
  assertEquals([...ACCT_ACTIONS].sort(), ["acct_list", "acct_report", "acct_switch", "acct_switch_pending", "acct_switch_result", "acct_switch_status"]);
});
