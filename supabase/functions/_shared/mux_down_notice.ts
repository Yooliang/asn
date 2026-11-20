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

// 壓縮次數到了的交接通知（20261120200000_compact_notice.sql，#1852）：只收視窗名、壓縮次數、結果種類、額度原因與剩餘百分比。
// 文字固定在資料庫函式；視窗名資料庫會再清一次，這裡先擋掉空白、過長與控制字元。
export const COMPACT_KINDS = ["auto", "remind_quota", "remind_unknown", "remind_off", "remind_failed"] as const;
export type CompactKind = typeof COMPACT_KINDS[number];
export type CompactNotice = { window: string; count: number; kind: CompactKind; reason: string | null; pct: number | null };

export function parseCompactNotice(body: unknown): CompactNotice | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const allowed = new Set(["window", "count", "kind", "reason", "pct"]);
  if (!Object.keys(b).every((k) => allowed.has(k))) return null;
  if (typeof b.window !== "string" || b.window.trim().length < 1 || b.window.length > NAME_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(b.window)) return null;
  if (typeof b.count !== "number" || !Number.isInteger(b.count) || b.count < 1 || b.count > COUNT_MAX) return null;
  if (typeof b.kind !== "string" || !(COMPACT_KINDS as readonly string[]).includes(b.kind)) return null;
  const kind = b.kind as CompactKind;
  const pct = b.pct ?? null;
  if (pct !== null && (typeof pct !== "number" || !Number.isInteger(pct) || pct < 0 || pct > 100)) return null;
  const reason = b.reason ?? null;
  if (kind === "remind_quota") {
    if (reason !== "5 小時" && reason !== "每週") return null;
  } else if (reason !== null) return null;
  return { window: b.window.trim(), count: b.count, kind, reason: reason as string | null, pct: pct as number | null };
}
