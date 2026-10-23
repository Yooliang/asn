// 無頭節點每小時用量回報（資料庫見 migrations/20261024100000_node_usage_hourly.sql）。
// usage_report：節點金鑰認證，只寫自己（節點由金鑰決定，body 不接受指定節點）；一次最多 48 筆，整批先檢查再寫。
// usage_list：只讀自己的，可帶 since（ISO 時間）；新的在前，最多 200 筆。
// deno-lint-ignore no-explicit-any
type Json = any;
import type { LaunchDeps, Reply } from "./launch.ts";

export const USAGE_ACTIONS = new Set(["usage_report", "usage_list"]);
export const USAGE_REPORT_MAX = 48;
export const USAGE_LIST_MAX = 200;
export const USAGE_FIELDS = [
  "input_tokens", "cache_read_tokens", "cache_creation_tokens", "output_tokens", "tasks_ok", "tasks_failed", "rounds",
] as const;
const HOUR_MS = 3600_000;
const MIN_HOUR_MS = Date.UTC(2020, 0, 1);

const STATUS: Record<string, number> = { forbidden: 403, internal: 500 };
const TEXT: Record<string, string> = {
  forbidden: "這個節點不能回報用量",
  bad_request: "資料格式不對",
  internal: "伺服器發生錯誤",
};
const fail = (code: string): Reply => ({ status: STATUS[code] ?? 400, body: { error: code, detail: TEXT[code] ?? "操作失敗" } });

export type UsageRow = { hour: string } & Record<(typeof USAGE_FIELDS)[number], number>;

// 第一層格式檢查（不查資料庫）：hour 要是整點的 ISO 時間（不得晚於現在一小時以上）；七個計數欄位都要是 0 以上的安全整數；多餘欄位（含 node）丟掉
export function parseUsageReport(b: Json, now = Date.now()): { rows: UsageRow[] } | { error: string } {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "bad_request" };
  const raw = b.rows;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > USAGE_REPORT_MAX) return { error: "bad_request" };
  const rows: UsageRow[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return { error: "bad_request" };
    if (typeof r.hour !== "string" || r.hour.length > 40) return { error: "bad_request" };
    const t = Date.parse(r.hour);
    if (!Number.isFinite(t) || t % HOUR_MS !== 0 || t < MIN_HOUR_MS || t > now + HOUR_MS) return { error: "bad_request" };
    const row = { hour: new Date(t).toISOString() } as UsageRow;
    for (const f of USAGE_FIELDS) {
      const v = r[f];
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v >= 1e15) return { error: "bad_request" };
      row[f] = v;
    }
    rows.push(row);
  }
  return { rows };
}

export function parseUsageList(params: Json): { since: string | null } | { error: string } {
  const s = params?.since;
  if (s == null || s === "") return { since: null };
  if (typeof s !== "string" || s.length > 40) return { error: "bad_request" };
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return { error: "bad_request" };
  return { since: new Date(t).toISOString() };
}

export async function handleUsageAction(deps: LaunchDeps, me: { id: string }, action: string, params: Json, now = Date.now()): Promise<Reply> {
  if (action === "usage_report") {
    const req = parseUsageReport(params, now);
    if ("error" in req) return fail(req.error);
    const { data, error } = await deps.rpc("asn_relay_usage_report", { p_node: me.id, p_rows: req.rows });
    if (error) {
      console.error("asn_relay_usage_report", error);
      return fail("internal");
    }
    if (data && typeof data === "object" && typeof data.error === "string") return fail(data.error);
    return { status: 200, body: { ok: true, saved: data?.saved ?? req.rows.length } };
  }
  if (action === "usage_list") {
    const req = parseUsageList(params);
    if ("error" in req) return fail(req.error);
    const { data, error } = await deps.rpc("asn_relay_usage_list", { p_node: me.id, p_since: req.since, p_limit: USAGE_LIST_MAX });
    if (error) {
      console.error("asn_relay_usage_list", error);
      return fail("internal");
    }
    if (data && typeof data === "object" && typeof data.error === "string") return fail(data.error);
    return { status: 200, body: { rows: Array.isArray(data?.rows) ? data.rows.slice(0, USAGE_LIST_MAX) : [] } };
  }
  return fail("bad_request");
}
