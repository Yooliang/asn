// 帳號回報帶剩餘額度（#228）：執行 cd supabase/functions && deno test -A _shared/account_switch_quota_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleAcctAction, parseReport } from "./account_switch.ts";

const AT = "2026-10-24T11:55:00.000Z";
const C = { vendor: "claude" as const, email: "a@x.test", plan: "max", current: true };

Deno.test("額度欄位：合格就保留（百分比取整），舊用戶端不帶就維持原樣", () => {
  const r = parseReport({ accounts: [{ ...C, five_hour_pct: 61.6, weekly_pct: 80, reset_at: "2026-10-24T15:00:00Z", at: AT }, C] })!;
  assertEquals(r[0], { ...C, five_hour_pct: 62, weekly_pct: 80, reset_at: "2026-10-24T15:00:00.000Z", at: AT });
  assertEquals(r[1], C, "沒帶額度的列不多出任何欄位");
});

Deno.test("額度欄位不合格只丟額度，不拖累整份帳號回報", () => {
  for (const bad of [
    { five_hour_pct: 101, at: AT }, { five_hour_pct: -1, at: AT }, { five_hour_pct: "50", at: AT }, { five_hour_pct: NaN, at: AT },
    { five_hour_pct: 50 }, { five_hour_pct: 50, at: "不是時間" }, { weekly_pct: 50, at: "2099-01-01T00:00:00Z" },
  ]) {
    const r = parseReport({ accounts: [{ ...C, ...bad }] });
    assert(r, JSON.stringify(bad));
    assertEquals(r![0], C, JSON.stringify(bad));
  }
  const half = parseReport({ accounts: [{ ...C, five_hour_pct: 30, weekly_pct: 500, reset_at: "壞掉", at: AT }] })!;
  assertEquals(half[0], { ...C, five_hour_pct: 30, at: AT }, "壞的欄位單獨丟掉，好的留著");
});

Deno.test("額度只收 Claude；Codex 帶了也丟掉", () => {
  const r = parseReport({ accounts: [{ vendor: "codex", email: "c@x.test", plan: "plus", current: true, five_hour_pct: 5, at: AT }] })!;
  assertEquals(r[0], { vendor: "codex", email: "c@x.test", plan: "plus", current: true });
});

Deno.test("守門：權杖類欄位不會跟著額度進後台", () => {
  const r = parseReport({ accounts: [{ ...C, five_hour_pct: 10, at: AT, accessToken: "SECRET", refresh_token: "SECRET", token: "SECRET" }] })!;
  assert(!JSON.stringify(r).includes("SECRET"));
  assertEquals(Object.keys(r[0]).sort(), ["at", "current", "email", "five_hour_pct", "plan", "vendor"]);
});

Deno.test("acct_report 把整理過的額度交給資料庫函式", async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const deps = { rpc: (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return Promise.resolve({ data: { ok: true, count: 1 }, error: null }); }, ring: () => Promise.resolve() };
  await handleAcctAction(deps, { id: "W" }, "acct_report", { accounts: [{ ...C, five_hour_pct: 40, at: AT }] });
  assertEquals(calls[0].args.p_accounts, [{ ...C, five_hour_pct: 40, at: AT }]);
});
