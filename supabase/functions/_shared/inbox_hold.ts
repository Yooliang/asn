// 這台電腦因收發室 worker 額度用完而暫停收信到什麼時候（roster 動作的選填欄位 inbox_hold_until，毫秒時間戳；null＝清掉）。
// 回 undefined＝看不懂或沒帶，這次不動；回 null＝清掉；回 ISO 字串＝設定（範圍由資料庫函式夾在 now() 到 now()+8 天）。
export function sanitizeInboxHold(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 8.64e15) return undefined;
  return new Date(v).toISOString();
}

// 暫停開始時後台寄給擁有者的通知要用的附帶欄位：設備名（1～40 字、無控制字元，否則 null＝只設時間不寄信）、扣住筆數（0～99999）、是否超過上限。
export function sanitizeInboxHoldExtra(b: Record<string, unknown>): { computer: string | null; held: number; capped: boolean } {
  const c = typeof b.inbox_hold_computer === "string" ? b.inbox_hold_computer.trim() : "";
  // deno-lint-ignore no-control-regex
  const computer = c && Array.from(c).length <= 40 && !/[\u0000-\u001f\u007f-\u009f]/.test(c) ? c : null;
  const n = b.inbox_hold_count;
  const held = typeof n === "number" && Number.isInteger(n) && n >= 0 ? Math.min(n, 99999) : 0;
  return { computer, held, capped: b.inbox_hold_capped === true };
}
