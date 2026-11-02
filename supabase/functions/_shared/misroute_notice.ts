// 核對轉交對象：電腦端回報「有一封信轉交錯了視窗」，後台寄固定內文的通知給節點擁有者（動作 misroute_notice）。
// 只收一個選填欄位 mail_id（uuid；群組訊息沒有就不帶或 null）；其他欄位一律丟掉。看不懂回 null＝bad_request。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseMisrouteNotice(b: unknown): { mailId: string | null } | null {
  if (b === null || typeof b !== "object" || Array.isArray(b)) return null;
  const v = (b as Record<string, unknown>).mail_id;
  if (v === undefined || v === null) return { mailId: null };
  if (typeof v !== "string" || !UUID_RE.test(v)) return null;
  return { mailId: v.toLowerCase() };
}
