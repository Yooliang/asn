// 已讀多端同步（設計見 docs/design/READ-SYNC.md；資料庫見 migrations/20261023080000_read_sync.sql）。
// read_sync：一次呼叫「寫入我這端的已讀位置＋取回整個帳號的已讀位置」。要本人簽章：沒簽章 401、完全不打資料庫。
// deno-lint-ignore no-explicit-any
type Json = any;
import type { LaunchDeps, Reply } from "./launch.ts";

export const READ_SYNC_MAX_MARKS = 100;
const hasControl = (s: string) => /[\u0000-\u001f\u007f]/.test(s);
const STATUS: Record<string, number> = { unauthorized: 401, forbidden: 403, rate_limited: 429, internal: 500 };
const TEXT: Record<string, string> = {
  unauthorized: "請先登入，才能同步已讀",
  forbidden: "只有使用者本人能同步已讀",
  rate_limited: "已讀記錄太多了",
  bad_request: "資料格式不對",
  internal: "伺服器發生錯誤",
};
const fail = (code: string): Reply => ({ status: STATUS[code] ?? 400, body: { error: code, detail: TEXT[code] ?? "操作失敗" } });

export type ReadMark = { key: string; at: number };

// 第一層格式檢查（不查資料庫）：marks 可省略或空陣列（只取回）；最多 100 筆；多餘欄位丟掉
export function parseReadSync(b: Json): { marks: ReadMark[] } | { error: string } {
  if (b == null) return { marks: [] };
  if (typeof b !== "object" || Array.isArray(b)) return { error: "bad_request" };
  const raw = b.marks ?? [];
  if (!Array.isArray(raw) || raw.length > READ_SYNC_MAX_MARKS) return { error: "bad_request" };
  const marks: ReadMark[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object" || Array.isArray(m)) return { error: "bad_request" };
    const { key, at } = m;
    if (typeof key !== "string" || key.length < 3 || key.length > 140 || hasControl(key)) return { error: "bad_request" };
    if (typeof at !== "number" || !Number.isFinite(at) || at <= 0 || at > 4102444800000) return { error: "bad_request" };
    marks.push({ key, at: Math.floor(at) });
  }
  return { marks };
}

export async function requestReadSync(deps: LaunchDeps, actor: string, raw: Json, signedUser: string | null): Promise<Reply> {
  if (!signedUser) return fail("unauthorized");
  const req = parseReadSync(raw);
  if ("error" in req) return fail(req.error);
  const { data, error } = await deps.rpc("asn_relay_read_sync", { p_actor: actor, p_signed_user: signedUser, p_marks: req.marks });
  if (error) {
    console.error("asn_relay_read_sync", error);
    return fail("internal");
  }
  if (data && typeof data === "object" && typeof data.error === "string") return fail(data.error);
  return { status: 200, body: { ok: true, marks: data?.marks && typeof data.marks === "object" ? data.marks : {} } };
}
