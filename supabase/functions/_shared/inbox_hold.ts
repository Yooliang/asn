// 這台電腦因收發室 worker 額度用完而暫停收信到什麼時候（roster 動作的選填欄位 inbox_hold_until，毫秒時間戳；null＝清掉）。
// 回 undefined＝看不懂或沒帶，這次不動；回 null＝清掉；回 ISO 字串＝設定（範圍由資料庫函式夾在 now() 到 now()+8 天）。
export function sanitizeInboxHold(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 8.64e15) return undefined;
  return new Date(v).toISOString();
}
