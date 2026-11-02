// 這台電腦因收發室 worker 額度用完而暫停收信到什麼時候（roster 動作的選填欄位 inbox_hold_until，毫秒時間戳；null＝清掉）。
// 回 undefined＝看不懂或沒帶，這次不動；回 null＝清掉；回 ISO 字串＝設定（範圍由資料庫函式夾在 now() 到 now()+8 天）。
export function sanitizeInboxHold(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 8.64e15) return undefined;
  return new Date(v).toISOString();
}

// 暫停開始時後台寄給擁有者的通知要用的附帶欄位：扣住筆數（0～99999）、是否超過上限。設備名由資料庫讀 relay.nodes.name，不收電腦端傳來的。
export function sanitizeInboxHoldExtra(b: Record<string, unknown>): { held: number; capped: boolean } {
  const n = b.inbox_hold_count;
  const held = typeof n === "number" && Number.isInteger(n) && n >= 0 ? Math.min(n, 99999) : 0;
  return { held, capped: b.inbox_hold_capped === true };
}
