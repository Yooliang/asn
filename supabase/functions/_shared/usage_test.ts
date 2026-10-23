// 執行：SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno test -A supabase/functions/_shared/usage_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { LaunchDeps } from "./launch.ts";
import { handleUsageAction, parseUsageList, parseUsageReport, USAGE_REPORT_MAX } from "./usage.ts";

const NOW = Date.parse("2026-10-24T12:30:00Z");
const row = (hour = "2026-10-24T11:00:00Z", extra: Record<string, unknown> = {}) => ({
  hour, input_tokens: 10, cache_read_tokens: 20, cache_creation_tokens: 30, output_tokens: 40, tasks_ok: 1, tasks_failed: 0, rounds: 2, ...extra,
});

type Call = { fn: string; args: Record<string, unknown> };
function fakeDeps(answer: (c: Call) => unknown = () => ({ ok: true, saved: 1 })) {
  const calls: Call[] = [];
  const deps: LaunchDeps = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      return Promise.resolve({ data: answer({ fn, args }), error: null });
    },
    ring: () => Promise.resolve(),
  };
  return { deps, calls };
}

Deno.test("parseUsageReport：正常資料通過，hour 正規化，多餘欄位（含 node）丟掉", () => {
  const r = parseUsageReport({ rows: [row("2026-10-24T11:00:00+00:00", { node: "別人", evil: 1 })] }, NOW);
  assert("rows" in r);
  assertEquals(r.rows[0], row("2026-10-24T11:00:00.000Z"));
});

Deno.test("parseUsageReport：格式不對一律 bad_request", () => {
  const bad = (b: unknown) => assertEquals(parseUsageReport(b, NOW), { error: "bad_request" });
  bad(null);
  bad([row()]);
  bad({});
  bad({ rows: [] });
  bad({ rows: "x" });
  bad({ rows: [null] });
  bad({ rows: [row("2026-10-24T11:30:00Z")] }); // 非整點
  bad({ rows: [row("not-a-time")] });
  bad({ rows: [row("2019-12-31T23:00:00Z")] }); // 太舊
  bad({ rows: [row("2026-10-24T14:00:00Z")] }); // 太未來
  bad({ rows: [row(undefined, { input_tokens: -1 })] });
  bad({ rows: [row(undefined, { rounds: 1.5 })] });
  bad({ rows: [row(undefined, { tasks_ok: "3" })] });
  bad({ rows: [row(undefined, { output_tokens: 1e15 })] });
  const lacking: Record<string, unknown> = row();
  delete lacking.rounds;
  bad({ rows: [lacking] });
});

Deno.test("parseUsageReport：最多 48 筆", () => {
  const mk = (n: number) => ({ rows: Array.from({ length: n }, (_, i) => row(new Date(NOW - 2 * 3600_000 - i * 3600_000 - (NOW % 3600_000)).toISOString())) });
  assert("rows" in parseUsageReport(mk(USAGE_REPORT_MAX), NOW));
  assertEquals(parseUsageReport(mk(USAGE_REPORT_MAX + 1), NOW), { error: "bad_request" });
});

Deno.test("parseUsageList：since 可省略；壞的擋下", () => {
  assertEquals(parseUsageList({}), { since: null });
  assertEquals(parseUsageList({ since: "2026-10-24T00:00:00Z" }), { since: "2026-10-24T00:00:00.000Z" });
  assertEquals(parseUsageList({ since: "xx" }), { error: "bad_request" });
});

Deno.test("usage_report：節點一律是金鑰所屬的自己，body 裡的 node 不採用", async () => {
  const { deps, calls } = fakeDeps();
  const r = await handleUsageAction(deps, { id: "T" }, "usage_report", { node: "別人", rows: [row()] }, NOW);
  assertEquals([r.status, r.body.ok], [200, true]);
  assertEquals(calls[0].fn, "asn_relay_usage_report");
  assertEquals(calls[0].args.p_node, "T");
});

Deno.test("usage_report：格式錯在打資料庫之前就 400；資料庫回 forbidden 對應 403", async () => {
  const a = fakeDeps();
  const r = await handleUsageAction(a.deps, { id: "T" }, "usage_report", { rows: [] }, NOW);
  assertEquals([r.status, r.body.error], [400, "bad_request"]);
  assertEquals(a.calls, []);
  const b = fakeDeps(() => ({ error: "forbidden" }));
  const f = await handleUsageAction(b.deps, { id: "T" }, "usage_report", { rows: [row()] }, NOW);
  assertEquals([f.status, f.body.error], [403, "forbidden"]);
});

Deno.test("usage_list：只問自己的、筆數上限 200、帶 since", async () => {
  const { deps, calls } = fakeDeps(() => ({ rows: [row()] }));
  const r = await handleUsageAction(deps, { id: "T" }, "usage_list", { since: "2026-10-23T00:00:00Z", node: "別人" }, NOW);
  assertEquals(r.status, 200);
  assertEquals(r.body.rows.length, 1);
  assertEquals(calls[0].args, { p_node: "T", p_since: "2026-10-23T00:00:00.000Z", p_limit: 200 });
  const big = fakeDeps(() => ({ rows: Array.from({ length: 300 }, () => row()) }));
  const r2 = await handleUsageAction(big.deps, { id: "T" }, "usage_list", {}, NOW);
  assertEquals(r2.body.rows.length, 200);
});

Deno.test("守門：index.ts 有接上 usage 動作，migration 有定義兩個函式與 RLS", async () => {
  const idx = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  assert(idx.includes("USAGE_ACTIONS.has(action)") && idx.includes("handleUsageAction"));
  const sql = await Deno.readTextFile(new URL("../../migrations/20261024100000_node_usage_hourly.sql", import.meta.url));
  for (const s of ["relay.node_usage_hourly", "enable row level security", "asn_relay_usage_report", "asn_relay_usage_list", "primary key (node, hour)"]) assert(sql.includes(s), s);
});
