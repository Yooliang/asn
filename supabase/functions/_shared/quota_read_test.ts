// 額度查詢（todo-next-193）。執行：cd supabase/functions && deno test -A _shared/quota_read_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleQuotaRead, handleQuotaShare, newShareCode, type QuotaDeps, quotaRecord } from "./quota_read.ts";

const NOW = Date.parse("2026-11-05T00:00:00Z");
const READ = "2026-11-04T23:55:00.000Z";
const LATER = "2026-11-05T03:00:00.000Z";
const CODE = "a".repeat(64);
const SIGNED = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const win = (name: string, left_pct: number, extra: Record<string, unknown> = {}) => ({ name, left_pct, resets_at: LATER, read_at: READ, ...extra });

function fake(answer: { data: unknown; error: unknown } = { data: { ok: true }, error: null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const deps: QuotaDeps = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      return Promise.resolve(answer);
    },
    sha256Hex: (s) => Promise.resolve("h(" + s + ")"),
  };
  return { deps, calls };
}

Deno.test("Claude：窗名與舊服務相同，剩餘轉成已用，欄位齊全", () => {
  const r = quotaRecord(CODE, { vendor: "claude", plan: "ultra", windows: [win("five_hour", 19), win("weekly", 71)] }, NOW);
  assertEquals(r, {
    hash: CODE, vendor: "claude", plan: "ultra",
    usage: { "工作階段": 81, "本週 · 全模型": 29 },
    resets: { "工作階段": LATER, "本週 · 全模型": LATER },
    expiry: "", reported_at: READ,
  });
});

Deno.test("Grok、MiniMax、Gemini、Codex 的窗名", () => {
  assertEquals(Object.keys(quotaRecord(CODE, { vendor: "grok", windows: [win("weekly", 50)] }, NOW).usage), ["每週 Super 限制（已用）"]);
  assertEquals(Object.keys(quotaRecord(CODE, { vendor: "minimax", windows: [win("five_hour", 50), win("weekly", 50)] }, NOW).usage), ["5小時（已用）", "週（已用）"]);
  assertEquals(Object.keys(quotaRecord(CODE, { vendor: "gemini", windows: [win("five_hour", 50), win("weekly", 50)] }, NOW).usage), ["Gemini Models 5小時", "Gemini Models 每週"]);
  assertEquals(Object.keys(quotaRecord(CODE, { vendor: "codex", windows: [win("five_hour", 50), win("weekly", 50)] }, NOW).usage), ["5小時（已用）", "每週（已用）"]);
});

Deno.test("缺值不補 0：沒有窗就是空的，回報時間是空，不是現在", () => {
  const r = quotaRecord(CODE, { vendor: "grok", windows: [] }, NOW);
  assertEquals(r.usage, {});
  assertEquals(r.reported_at, null);
  assertEquals(quotaRecord(CODE, { vendor: "claude", windows: null }, NOW).usage, {});
});

Deno.test("壞的窗丟掉：不認得的窗名、left_pct 不是數字或超範圍、沒有讀取時間", () => {
  const r = quotaRecord(CODE, {
    vendor: "claude",
    windows: [win("w60", 50), win("five_hour", 101), { name: "weekly", left_pct: "50", read_at: READ }, { name: "weekly", left_pct: 50 }, null],
  }, NOW);
  assertEquals(r.usage, {});
});

Deno.test("reported_at 是資料的讀取時間；比最新的舊超過 30 分鐘的窗不回", () => {
  const r = quotaRecord(CODE, { vendor: "claude", windows: [win("weekly", 70), win("five_hour", 10, { read_at: "2026-11-04T23:00:00.000Z" })] }, NOW);
  assertEquals(r.usage, { "本週 · 全模型": 30 });
  assertEquals(r.reported_at, READ);
});

Deno.test("重置時間已過的窗不回；全部過了還是留回報時間，讓讀取端顯示過期", () => {
  const r = quotaRecord(CODE, { vendor: "claude", windows: [win("five_hour", 10, { resets_at: "2026-11-04T23:59:00.000Z" }), win("weekly", 70)] }, NOW);
  assertEquals(r.usage, { "本週 · 全模型": 30 });
  const all = quotaRecord(CODE, { vendor: "claude", windows: [win("five_hour", 10, { resets_at: "2026-11-04T23:59:00.000Z" })] }, NOW);
  assertEquals(all.usage, {});
  assertEquals(all.reported_at, READ);
});

Deno.test("沒有重置時間的窗照回，只是 resets 沒有那一項", () => {
  const r = quotaRecord(CODE, { vendor: "minimax", windows: [win("weekly", 40, { resets_at: null })] }, NOW);
  assertEquals(r.usage, { "週（已用）": 60 });
  assertEquals(r.resets, {});
});

Deno.test("查詢：代碼格式不對回 400，不碰資料庫", async () => {
  const { deps, calls } = fake();
  for (const bad of ["", "abc", "A".repeat(64), "g".repeat(64), CODE + "a"]) {
    assertEquals((await handleQuotaRead(deps, bad, "1.1.1.1")).status, 400);
  }
  assertEquals(calls.length, 0);
});

Deno.test("查詢：資料庫只收雜湊，不收代碼與來源原文", async () => {
  const { deps, calls } = fake({ data: { record: null }, error: null });
  const r = await handleQuotaRead(deps, CODE, "1.1.1.1");
  assertEquals(r, { status: 200, body: { record: null } });
  assertEquals(calls, [{ fn: "asn_relay_quota_read", args: { p_ip_hash: "h(ip:1.1.1.1)", p_code_hash: `h(${CODE})` } }]);
});

Deno.test("查詢：查到回紀錄且不含 email；超量 429；資料庫錯誤 500 不外洩內容", async () => {
  const found = await handleQuotaRead(fake({ data: { record: { vendor: "claude", plan: "ultra", windows: [] } }, error: null }).deps, CODE, "1.1.1.1");
  assertEquals(found.status, 200);
  assertEquals(found.body.record.vendor, "claude");
  assert(!JSON.stringify(found.body).includes("@"));
  assertEquals((await handleQuotaRead(fake({ data: { error: "rate_limited" }, error: null }).deps, CODE, "1.1.1.1")).status, 429);
  assertEquals(await handleQuotaRead(fake({ data: null, error: { message: "secret detail" } }).deps, CODE, "1.1.1.1"), { status: 500, body: { error: "read_failed" } });
});

Deno.test("開代碼：沒有本人簽章 403，不碰資料庫", async () => {
  const { deps, calls } = fake();
  const r = await handleQuotaShare(deps, { id: "W" }, "acct_share_create", { vendor: "claude", account: "a@x.test" }, null);
  assertEquals(r.status, 403);
  assertEquals(calls.length, 0);
});

Deno.test("開代碼：資料庫只存雜湊，代碼只回給本人一次；email 轉小寫", async () => {
  const { deps, calls } = fake();
  const r = await handleQuotaShare(deps, { id: "W" }, "acct_share_create", { vendor: "minimax", account: " A@x.test " }, SIGNED, () => CODE);
  assertEquals(r, { status: 200, body: { ok: true, code: CODE } });
  assertEquals(calls[0], { fn: "asn_relay_acct_share_set", args: { p_actor: "W", p_signed_user: SIGNED, p_vendor: "minimax", p_account: "a@x.test", p_code_hash: `h(${CODE})` } });
});

Deno.test("撤代碼：傳空雜湊，不回代碼", async () => {
  const { deps, calls } = fake();
  const r = await handleQuotaShare(deps, { id: "W" }, "acct_share_revoke", { vendor: "claude", account: "a@x.test" }, SIGNED);
  assertEquals(r, { status: 200, body: { ok: true } });
  assertEquals(calls[0].args.p_code_hash, null);
});

Deno.test("開代碼：廠牌、email 不合格 400；別人的帳號或查無此列照資料庫回", async () => {
  const { deps, calls } = fake();
  assertEquals((await handleQuotaShare(deps, { id: "W" }, "acct_share_create", { vendor: "x", account: "a@x.test" }, SIGNED)).status, 400);
  assertEquals((await handleQuotaShare(deps, { id: "W" }, "acct_share_create", { vendor: "claude", account: "壞" }, SIGNED)).status, 400);
  assertEquals(calls.length, 0);
  assertEquals((await handleQuotaShare(fake({ data: { error: "forbidden" }, error: null }).deps, { id: "W" }, "acct_share_create", { vendor: "claude", account: "a@x.test" }, SIGNED)).status, 403);
  assertEquals((await handleQuotaShare(fake({ data: { error: "not_found" }, error: null }).deps, { id: "W" }, "acct_share_create", { vendor: "claude", account: "a@x.test" }, SIGNED)).status, 404);
});

Deno.test("新代碼是 64 字元小寫十六進位，每次不同", () => {
  const a = newShareCode();
  assert(/^[0-9a-f]{64}$/.test(a));
  assert(a !== newShareCode());
});
