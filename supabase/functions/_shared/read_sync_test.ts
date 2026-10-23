// 執行：SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno test -A supabase/functions/_shared/
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { LaunchDeps } from "./launch.ts";
import { parseReadSync, READ_SYNC_MAX_MARKS, requestReadSync } from "./read_sync.ts";

type Call = { fn: string; args: Record<string, unknown> };
function fakeDeps(answer: (c: Call) => { data?: unknown; error?: unknown } = () => ({ data: { ok: true, marks: { k1x: 5 } } })) {
  const calls: Call[] = [];
  const rings: string[] = [];
  const deps: LaunchDeps = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      const r = answer({ fn, args });
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
    ring: (t) => {
      rings.push(t);
      return Promise.resolve();
    },
  };
  return { deps, calls, rings };
}
const USER = "99999999-9999-9999-9999-999999999999";

Deno.test("沒有本人簽章：401，完全不打資料庫", async () => {
  const { deps, calls } = fakeDeps();
  const r = await requestReadSync(deps, "P", { marks: [] }, null);
  assertEquals([r.status, r.body.error], [401, "unauthorized"]);
  assertEquals(calls, []);
});

Deno.test("parseReadSync：可省略／空陣列；多餘欄位丟掉；壞格式在進資料庫前擋下", () => {
  assertEquals(parseReadSync(null), { marks: [] });
  assertEquals(parseReadSync({}), { marks: [] });
  assertEquals(parseReadSync({ marks: [{ key: "n:H/a", at: 1700000000000.9, extra: 1 }] }), { marks: [{ key: "n:H/a", at: 1700000000000 }] });
  for (const bad of [
    [], "x", { marks: "x" }, { marks: [null] }, { marks: [[]] },
    { marks: [{ key: "ab", at: 5 }] },
    { marks: [{ key: "x".repeat(141), at: 5 }] },
    { marks: [{ key: "a\nb", at: 5 }] },
    { marks: [{ key: "abc", at: 0 }] },
    { marks: [{ key: "abc", at: -1 }] },
    { marks: [{ key: "abc", at: "5" }] },
    { marks: [{ key: "abc", at: 4102444800001 }] },
    { marks: [{ key: "abc" }] },
    { marks: Array.from({ length: READ_SYNC_MAX_MARKS + 1 }, (_, i) => ({ key: `n:H/${i}`, at: 5 })) },
  ]) assertEquals(parseReadSync(bad as never), { error: "bad_request" }, JSON.stringify(bad).slice(0, 80));
  assertEquals((parseReadSync({ marks: Array.from({ length: READ_SYNC_MAX_MARKS }, (_, i) => ({ key: `n:H/${i}`, at: 5 })) }) as { marks: unknown[] }).marks.length, READ_SYNC_MAX_MARKS);
});

Deno.test("帶簽章呼叫資料庫函式（用 asn_relay_ 新名），回整個帳號的已讀位置，不敲門鈴", async () => {
  const { deps, calls, rings } = fakeDeps();
  const r = await requestReadSync(deps, "P", { marks: [{ key: "k1x", at: 5 }] }, USER);
  assertEquals([r.status, r.body], [200, { ok: true, marks: { k1x: 5 } }]);
  assertEquals(calls, [{ fn: "asn_relay_read_sync", args: { p_actor: "P", p_signed_user: USER, p_marks: [{ key: "k1x", at: 5 }] } }]);
  assertEquals(rings, []);
});

Deno.test("資料庫錯誤碼對應；資料庫例外是 500", async () => {
  for (const [code, status] of [["forbidden", 403], ["rate_limited", 429], ["bad_request", 400]] as const) {
    const x = await requestReadSync(fakeDeps(() => ({ data: { error: code } })).deps, "P", { marks: [] }, USER);
    assertEquals([x.status, x.body.error], [status, code]);
  }
  const boom = await requestReadSync(fakeDeps(() => ({ error: { message: "x" } })).deps, "P", {}, USER);
  assertEquals([boom.status, boom.body.error], [500, "internal"]);
  const odd = await requestReadSync(fakeDeps(() => ({ data: { ok: true } })).deps, "P", {}, USER);
  assertEquals(odd.body, { ok: true, marks: {} });
});

Deno.test("後台入口只在 read_sync 讀本人簽章，且沒簽章不會被當成其他動作", async () => {
  const idx = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  assert(/action === "read_sync"\) \{[\s\S]*?signedUserId\(accountDeps\.verifyJwt, req\.headers\.get\(SIGN_HEADER\)\)[\s\S]*?requestReadSync\(/.test(idx));
});
