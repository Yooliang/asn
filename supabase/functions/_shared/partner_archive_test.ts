// 執行：SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno test -A supabase/functions/_shared/
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { LaunchDeps } from "./launch.ts";
import { handleNodePartnerOpAction, PARTNER_OP_ACTIONS, parsePartnerArchive, requestPartnerArchive } from "./partner_ops.ts";

type Call = { fn: string; args: Record<string, unknown> };
function fakeDeps(answer: (c: Call) => unknown = () => ({ ok: true, archived: true })) {
  const calls: Call[] = [];
  const rings: string[] = [];
  const deps: LaunchDeps = {
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
const USER = "99999999-9999-9999-9999-999999999999";
const PID = "p_0123456789abcdef0123";

Deno.test("沒有本人簽章：封存是 401，完全不打資料庫", async () => {
  const { deps, calls } = fakeDeps();
  const a = await requestPartnerArchive(deps, "P", { node: "H", partner_id: PID, archived: true }, null);
  assertEquals([a.status, a.body.error], [401, "unauthorized"]);
  const b = await handleNodePartnerOpAction(deps, { id: "P" }, "partner_archive", { node: "H", partner_id: PID, archived: true }, null);
  assertEquals(b.status, 401);
  assertEquals(calls, []);
});

Deno.test("parsePartnerArchive：夥伴 ID 或名字至少有一個；archived 一定要是布林；壞格式在進資料庫前擋下", () => {
  assertEquals(parsePartnerArchive({ node: "H", partner_id: PID, archived: true }), { node: "H", name: null, partner_id: PID, archived: true });
  assertEquals(parsePartnerArchive({ node: "H", name: "小文", archived: false }), { node: "H", name: "小文", partner_id: null, archived: false });
  assertEquals(parsePartnerArchive({ node: "H", name: "小文", partner_id: "", archived: true }), { node: "H", name: "小文", partner_id: null, archived: true });
  for (const bad of [
    null, [], "x", {},
    { node: "H", archived: true },
    { node: "H", name: "", archived: true },
    { node: "H", name: "x".repeat(81), archived: true },
    { node: "H", name: "a\nb", archived: true },
    { node: "H", partner_id: "p_xyz", archived: true },
    { node: "H", partner_id: PID },
    { node: "H", partner_id: PID, archived: "true" },
    { node: "a/b", partner_id: PID, archived: true },
    { partner_id: PID, archived: true },
  ]) assertEquals(parsePartnerArchive(bad as never), { error: "bad_request" }, JSON.stringify(bad));
});

Deno.test("封存：帶本人簽章呼叫資料庫函式，不敲門鈴；錯誤碼對應", async () => {
  const { deps, calls, rings } = fakeDeps();
  const r = await requestPartnerArchive(deps, "P", { node: "H", partner_id: PID, archived: true, extra: "丟掉" }, USER);
  assertEquals([r.status, r.body], [200, { ok: true, archived: true }]);
  assertEquals(calls, [{ fn: "irori_relay_partner_archive", args: { p_actor: "P", p_signed_user: USER, p_node: "H", p_name: null, p_partner_id: PID, p_archived: true } }]);
  assertEquals(rings, []);
  for (const [code, status] of [["forbidden", 403], ["not_found", 404], ["protected", 403], ["rate_limited", 429], ["bad_request", 400]] as const) {
    const f = fakeDeps(() => ({ error: code }));
    const x = await requestPartnerArchive(f.deps, "P", { node: "H", name: "小文", archived: true }, USER);
    assertEquals([x.status, x.body.error], [status, code]);
  }
  const off = await requestPartnerArchive(fakeDeps(() => ({ ok: true, archived: false })).deps, "P", { node: "H", partner_id: PID, archived: false }, USER);
  assertEquals(off.body, { ok: true, archived: false });
});

Deno.test("partner_archive 在後台的分派清單裡（節點金鑰動作）", () => {
  assert(PARTNER_OP_ACTIONS.has("partner_archive"));
});
