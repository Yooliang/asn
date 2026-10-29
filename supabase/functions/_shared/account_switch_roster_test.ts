// 帳號列表第一批（#374）：windows 驗證、grok 不收額度、壞單窗丟、acct_report 多寫一份但失敗不影響、acct_roster 要本人簽章。
// 執行：cd supabase/functions && deno test -A _shared/account_switch_roster_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { ACCT_ACTIONS, type AcctDeps, handleAcctAction, parseReport, parseWindows } from "./account_switch.ts";

const AT = new Date(Date.now() - 5 * 60_000).toISOString();
const RESET = "2026-11-01T16:00:00.000Z";
const C = { vendor: "claude" as const, email: "a@x.test", plan: "max", current: true };
const SIGNED = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
type Call = { fn: string; args: Record<string, unknown> };

function fakeDeps(answer: (c: Call) => { data: unknown; error: unknown } | Promise<never> = () => ({ data: { ok: true, count: 1, skipped: [] }, error: null })) {
  const calls: Call[] = [];
  const deps: AcctDeps = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      return Promise.resolve(answer({ fn, args })) as Promise<{ data: unknown; error: unknown }>;
    },
    ring: () => Promise.resolve(),
  };
  return { deps, calls };
}

Deno.test("windows：合格的保留（百分比取整、時間轉 UTC）", () => {
  const w = parseWindows([
    { name: "five_hour", left_pct: 61.6, resets_at: "2026-11-02T00:00:00+08:00", read_at: AT },
    { name: "weekly", left_pct: 80, resets_at: null, read_at: AT },
    { name: "w60", left_pct: 0, read_at: AT },
  ]);
  assertEquals(w, [
    { name: "five_hour", left_pct: 62, resets_at: RESET, read_at: AT },
    { name: "weekly", left_pct: 80, resets_at: null, read_at: AT },
    { name: "w60", left_pct: 0, resets_at: null, read_at: AT },
  ]);
});

Deno.test("windows：壞的單窗丟掉、同名留第一個、最多 4 個、未來時間不收", () => {
  const future = new Date(Date.now() + 30 * 60_000).toISOString();
  const w = parseWindows([
    { name: "five_hour", left_pct: 101, read_at: AT }, { name: "five_hour", left_pct: "50", read_at: AT },
    { name: "壞名字", left_pct: 5, read_at: AT }, { name: "weekly", left_pct: 50, resets_at: "壞掉", read_at: AT },
    { name: "weekly", left_pct: 50, read_at: future }, { name: "weekly", left_pct: 50 }, null, "x",
    { name: "five_hour", left_pct: 20, read_at: AT }, { name: "five_hour", left_pct: 10, read_at: AT },
    { name: "w1", left_pct: 1, read_at: AT }, { name: "w2", left_pct: 2, read_at: AT }, { name: "w3", left_pct: 3, read_at: AT }, { name: "w4", left_pct: 4, read_at: AT },
  ]);
  assertEquals(w.map((x) => [x.name, x.left_pct]), [["five_hour", 20], ["w1", 1], ["w2", 2], ["w3", 3]]);
  assertEquals(parseWindows("不是陣列"), []);
});

Deno.test("parseReport：claude、codex 放行 windows；grok 一律不收額度；windows 壞掉不退回整份", () => {
  const r = parseReport({ accounts: [
    { ...C, windows: [{ name: "weekly", left_pct: 50, read_at: AT }, { name: "weekly", left_pct: 999, read_at: AT }] },
    { vendor: "codex", email: "c@x.test", plan: "plus", current: false, windows: [{ name: "w300", left_pct: 70, resets_at: RESET, read_at: AT }] },
    { vendor: "grok", email: "g@x.test", windows: [{ name: "weekly", left_pct: 50, read_at: AT }], five_hour_pct: 5, at: AT },
    { ...C, email: "b@x.test", windows: "壞掉" },
  ] })!;
  assert(r);
  assertEquals(r[0].windows, [{ name: "weekly", left_pct: 50, resets_at: null, read_at: AT }]);
  assertEquals(r[1].windows, [{ name: "w300", left_pct: 70, resets_at: RESET, read_at: AT }]);
  assertEquals(r[2], { vendor: "grok", email: "g@x.test", plan: "", current: false });
  assertEquals(r[3], { ...C, email: "b@x.test" }, "windows 不是陣列就當沒帶");
  assert(!("windows" in parseReport({ accounts: [C] })![0]), "舊用戶端不帶就不多欄位");
});

Deno.test("acct_report：先照舊呼叫舊函式（不帶 windows），再呼叫新的 roster_report", async () => {
  const { deps, calls } = fakeDeps();
  const w = [{ name: "weekly", left_pct: 50, resets_at: null, read_at: AT }];
  const r = await handleAcctAction(deps, { id: "W" }, "acct_report", { accounts: [{ ...C, five_hour_pct: 40, at: AT, windows: w }] });
  assertEquals(r, { status: 200, body: { ok: true, count: 1 } });
  assertEquals(calls.map((c) => c.fn), ["asn_relay_acct_report", "asn_relay_acct_roster_report"]);
  assertEquals(calls[0].args.p_accounts, [{ ...C, five_hour_pct: 40, at: AT }]);
  assertEquals(calls[1].args, { p_node: "W", p_accounts: [{ ...C, five_hour_pct: 40, at: AT, windows: w }] });
});

Deno.test("acct_report：roster_report 失敗（錯誤、拋例外、回 error）只記 log，照樣回 ok", async () => {
  const answers: Array<(c: Call) => { data: unknown; error: unknown } | Promise<never>> = [
    () => ({ data: null, error: { message: "function does not exist" } }),
    () => Promise.reject(new Error("網路斷了")),
    () => ({ data: { error: "not_claimed" }, error: null }),
    () => ({ data: { ok: true, count: 1, skipped: [{ vendor: "claude", window: "weekly", reason: "earlier" }] }, error: null }),
  ];
  for (const bad of answers) {
    const { deps, calls } = fakeDeps((c) => c.fn === "asn_relay_acct_report" ? { data: { ok: true, count: 1 }, error: null } : bad(c));
    const r = await handleAcctAction(deps, { id: "W" }, "acct_report", { accounts: [C] });
    assertEquals(r, { status: 200, body: { ok: true, count: 1 } });
    assertEquals(calls.length, 2);
  }
});

Deno.test("acct_report：舊函式失敗就照舊回錯，不呼叫新的", async () => {
  const { deps, calls } = fakeDeps(() => ({ data: { error: "not_found" }, error: null }));
  const r = await handleAcctAction(deps, { id: "W" }, "acct_report", { accounts: [C] });
  assertEquals(r.status, 404);
  assertEquals(calls.map((c) => c.fn), ["asn_relay_acct_report"]);
});

Deno.test("relay/index.ts：acct_roster 讀本人簽章（照 acct_list 的做法）", () => {
  const src = Deno.readTextFileSync(new URL("../relay/index.ts", import.meta.url));
  assert(/const signedAcct = \([^)]*action === "acct_list"[^)]*action === "acct_roster"\) \? await signedUserId\(/.test(src));
});

Deno.test("acct_roster：沒簽章回 forbidden、不呼叫資料庫；有簽章帶 p_actor 與 p_signed_user", async () => {
  assert(ACCT_ACTIONS.has("acct_roster"));
  const a = fakeDeps();
  const r = await handleAcctAction(a.deps, { id: "P" }, "acct_roster", {});
  assertEquals(r.status, 403);
  assertEquals(a.calls.length, 0);
  const body = { now: "2026-11-01T00:00:00Z", accounts: [] };
  const b = fakeDeps(() => ({ data: body, error: null }));
  const ok = await handleAcctAction(b.deps, { id: "P" }, "acct_roster", { signed_user: "別人" }, SIGNED);
  assertEquals(ok, { status: 200, body });
  assertEquals(b.calls, [{ fn: "asn_relay_acct_roster", args: { p_actor: "P", p_signed_user: SIGNED } }]);
  const c = fakeDeps(() => ({ data: { error: "forbidden" }, error: null }));
  assertEquals((await handleAcctAction(c.deps, { id: "P" }, "acct_roster", {}, SIGNED)).status, 403);
});
