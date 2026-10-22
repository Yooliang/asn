// 機器橋回報的視窗名單（roster 動作）的整理：只取 name／status／cwd_label／engine，多餘欄位丟掉。
// engine＝這個視窗背後是哪家 AI（claude／codex／gemini／grok…）。格式不對或沒帶（舊版機器橋）就是 null，
// 不因此拒絕整份名單；detail（選填，最多 80 字）同理；資料庫那邊也有同樣的格式檢查（supabase/sql/19_roster_engine.sql）。

export type RosterAgent = { name: unknown; status: unknown; cwd_label: unknown; engine: string | null; detail: string | null };

export const DETAIL_MAX = 80;

export const ENGINE_RE = /^[a-z][a-z0-9_-]{0,19}$/;

export function normalizeRosterAgents(agents: Array<Record<string, unknown>>): RosterAgent[] {
  return agents.map((a) => ({
    name: a?.name,
    status: a?.status ?? null,
    cwd_label: a?.cwd_label ?? null,
    engine: typeof a?.engine === "string" && ENGINE_RE.test(a.engine) ? a.engine : null,
    // 可選的補充說明（Claude Code 外掛狀態）：不是字串或空白＝null，過長截斷，不因此拒絕整份名單
    detail: typeof a?.detail === "string" && a.detail.trim() ? [...a.detail.trim()].slice(0, DETAIL_MAX).join("") : null,
  }));
}
