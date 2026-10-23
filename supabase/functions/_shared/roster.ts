// 機器橋回報的視窗名單（roster 動作）的整理：只取 name／status／cwd_label／engine，多餘欄位丟掉。
// engine＝這個視窗背後是哪家 AI（claude／codex／gemini／grok…）。格式不對或沒帶（舊版機器橋）就是 null，
// 不因此拒絕整份名單；detail（選填，最多 80 字）同理；資料庫那邊也有同樣的格式檢查（supabase/sql/19_roster_engine.sql）。

export type RosterAgent = { name: unknown; status: unknown; cwd_label: unknown; engine: string | null; detail: string | null; context_pct: number | null; mod_loaded: boolean | null; kind: string; receivable: boolean; model: string | null };

export const DETAIL_MAX = 80;
export const MODEL_MAX = 60;

/** 名單回報後要敲的門鈴：資料庫回 bell_topics（只有名單有變且過了頻率限制才有）；不是字串陣列或舊資料庫沒有＝空，最多 20 個 */
export function rosterBellTopics(data: unknown): string[] {
  const l = (data as { bell_topics?: unknown } | null)?.bell_topics;
  if (!Array.isArray(l)) return [];
  return [...new Set(l.filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= 100))].slice(0, 20);
}

// 上下文已用百分比：只收 0～100 的有限數字（四捨五入成整數），其餘＝null，不因此拒絕整份名單
export function contextPct(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : null;
}

export const ENGINE_RE = /^[a-z][a-z0-9_-]{0,19}$/;

export function normalizeRosterAgents(agents: Array<Record<string, unknown>>): RosterAgent[] {
  return agents.map((a) => ({
    name: a?.name,
    status: a?.status ?? null,
    cwd_label: a?.cwd_label ?? null,
    engine: typeof a?.engine === "string" && ENGINE_RE.test(a.engine) ? a.engine : null,
    // 可選的補充說明（Claude Code 外掛狀態）：不是字串或空白＝null，過長截斷，不因此拒絕整份名單
    detail: typeof a?.detail === "string" && a.detail.trim() ? [...a.detail.trim()].slice(0, DETAIL_MAX).join("") : null,
    context_pct: contextPct(a?.context_pct),
    // 這個視窗有沒有載入 ASN 外掛（選填，只收布林；舊版機器橋沒帶＝null）
    mod_loaded: typeof a?.mod_loaded === "boolean" ? a.mod_loaded : null,
    // 條目種類（window＝AI 視窗；service 等）／能不能收信／背後的模型：舊版沒帶或壞值＝window／true／null
    kind: typeof a?.kind === "string" && ENGINE_RE.test(a.kind) ? a.kind : "window",
    receivable: typeof a?.receivable === "boolean" ? a.receivable : true,
    model: typeof a?.model === "string" && a.model.trim() ? [...a.model.trim()].slice(0, MODEL_MAX).join("") : null,
  }));
}
