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

// 接回做完之後的結果通知（20261120100000_mux_resume_notice.sql，#1818）：斷了幾位、接回幾位、沒接回的名字。
// 名字只用來顯示，資料庫函式會再清一次；這裡先擋掉不像名字的內容。沒接回的原因是技術細節，不收。
const NAME_MAX = 64;

export type MuxResumeNotice = { count: number; resumed: number; failed: string[] };

export function parseMuxResumeNotice(body: unknown): MuxResumeNotice | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.count !== "number" || !Number.isInteger(b.count) || b.count < 1 || b.count > COUNT_MAX) return null;
  if (typeof b.resumed !== "number" || !Number.isInteger(b.resumed) || b.resumed < 0 || b.resumed > b.count) return null;
  if (!Array.isArray(b.failed) || b.failed.length > COUNT_MAX) return null;
  if (!b.failed.every((n) => typeof n === "string" && n.length >= 1 && n.length <= NAME_MAX)) return null;
  if (b.resumed + b.failed.length !== b.count) return null;
  return { count: b.count, resumed: b.resumed, failed: b.failed as string[] };
}
