// 共用終端服務（mux）掛掉（#596 第 4 項）：驗證電腦端送來的內容。
// 節點一律取自金鑰；這裡只收中斷的夥伴數和有沒有自動接回。文字固定在資料庫函式。
// 夥伴數 0＝服務裡沒有夥伴（只通知「這台的終端服務停了」；舊的資料庫函式會回 bad_request，電腦端只記 log）。
const COUNT_MAX = 100;

export type MuxDownNotice = { count: number; resumed: boolean };

export function parseMuxDownNotice(body: unknown): MuxDownNotice | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.count !== "number" || !Number.isInteger(b.count) || b.count < 0 || b.count > COUNT_MAX) return null;
  if (typeof b.resumed !== "boolean") return null;
  return { count: b.count, resumed: b.resumed };
}
