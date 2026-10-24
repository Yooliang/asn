// 叫醒順位的「排序判斷」介面（#230）：一則訊息同時叫醒多個 AI 時，給每位一個 0～1 的「該不該由他回答」分數。
// 這裡只定義介面、設定、快取、逾時與退回；Jev 只是其中一個實作（makeJevScorer）。ASN 不依賴 Irori：
// 端點網址與金鑰走環境變數（JEV_URL、JEV_KEY），絕不寫進程式、不進 log。
// 任何失敗（沒開、沒設定、逾時、出錯、格式不對、少了某人的分數）一律回 null，呼叫端退回固定順位（rooms.ts wakeOrder 的標示排序）。
// 記錄只有次數與分數統計，不存訊息內文。

export type RankCandidate = { id: string; label: string };
export type RankRecent = { from: string; body: string };
export type RankInput = { body: string; recent: RankRecent[]; candidates: RankCandidate[]; mentioned?: string[] };
/** 排序判斷：回 {候選 id → 0～1 分數}；失敗回 null */
export type RankScorer = (input: RankInput) => Promise<Record<string, number> | null>;

export const DEFAULT_MIN = 0.5; // 低於這個分數的先不通知（JEV_RANK_MIN 可調）
export const DEFAULT_TIMEOUT_MS = 3000; // JEV_RANK_TIMEOUT_MS 可調
export const DEFAULT_MODEL = "jev-1.13.0"; // 釘版本：分數門檻是針對這一版校準的（JEV_MODEL 可覆蓋）
const BODY_CHARS = 400;
const RECENT_MSGS = 6;

export type RankConfig = { enabled: boolean; min: number; timeoutMs: number; exemptMentioned: boolean };
type Getenv = (k: string) => string | undefined;
const realEnv: Getenv = (k) => {
  try { return Deno.env.get(k); } catch { return undefined; }
};
const numIn = (v: string | undefined, lo: number, hi: number, dflt: number): number => {
  const n = v === undefined || v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
};
/** 設定：JEV_RANK_ENABLED（1／true／on 才開，預設關）、JEV_RANK_MIN、JEV_RANK_TIMEOUT_MS、JEV_RANK_EXEMPT_MENTIONED（預設 1：被明確點名的不因低分被略過） */
export function rankConfig(get: Getenv = realEnv): RankConfig {
  const on = (get("JEV_RANK_ENABLED") ?? "").trim().toLowerCase();
  const ex = (get("JEV_RANK_EXEMPT_MENTIONED") ?? "1").trim().toLowerCase();
  return {
    enabled: on === "1" || on === "true" || on === "on",
    min: numIn(get("JEV_RANK_MIN"), 0, 1, DEFAULT_MIN),
    timeoutMs: numIn(get("JEV_RANK_TIMEOUT_MS"), 100, 30000, DEFAULT_TIMEOUT_MS),
    exemptMentioned: !(ex === "0" || ex === "false" || ex === "off"),
  };
}

// ── 次數與分數統計（只記數字，不存內文）──
type Stats = { calls: number; ok: number; fallback: Record<string, number>; cache_hits: number; held: number; scores: { lt02: number; lt05: number; lt08: number; ge08: number } };
const stats: Stats = { calls: 0, ok: 0, fallback: {}, cache_hits: 0, held: 0, scores: { lt02: 0, lt05: 0, lt08: 0, ge08: 0 } };
export const rankStats = (): Stats => JSON.parse(JSON.stringify(stats));
export function resetRankStats(): void {
  stats.calls = 0; stats.ok = 0; stats.fallback = {}; stats.cache_hits = 0; stats.held = 0;
  stats.scores = { lt02: 0, lt05: 0, lt08: 0, ge08: 0 };
}
const noteFallback = (why: string) => { stats.fallback[why] = (stats.fallback[why] ?? 0) + 1; };
export function noteHeld(n: number): void { stats.held += n; }
function noteScores(s: Record<string, number>): void {
  for (const v of Object.values(s)) {
    if (v < 0.2) stats.scores.lt02++; else if (v < 0.5) stats.scores.lt05++; else if (v < 0.8) stats.scores.lt08++; else stats.scores.ge08++;
  }
}

const valid = (s: unknown, input: RankInput): s is Record<string, number> => {
  if (!s || typeof s !== "object") return false;
  return input.candidates.every((c) => {
    const v = (s as Record<string, unknown>)[c.id];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  });
};

/** 呼叫排序判斷：逾時（預設 3 秒）、出錯、格式不對、少了誰的分數都回 null（呼叫端退回固定順位）。不丟例外 */
export async function scoreWake(scorer: RankScorer | null | undefined, input: RankInput, cfg: Pick<RankConfig, "timeoutMs">): Promise<Record<string, number> | null> {
  if (!scorer) { noteFallback("unset"); return null; }
  stats.calls++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), cfg.timeoutMs); });
    const res = await Promise.race([scorer(input), timeout]);
    if (res === "timeout") { noteFallback("timeout"); console.warn("wake_rank: timeout"); return null; }
    if (!valid(res, input)) { noteFallback("bad_result"); console.warn("wake_rank: bad result"); return null; }
    stats.ok++;
    noteScores(res);
    console.info("wake_rank", JSON.stringify({ n: input.candidates.length, scores: input.candidates.map((c) => Math.round(res[c.id] * 100) / 100) }));
    return res;
  } catch (e) {
    noteFallback("error");
    console.warn("wake_rank: error", String((e as Error)?.name ?? "error")); // 只記錯誤種類，不印訊息（可能含網址）
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 同一則訊息短暫快取（同時進行中的請求共用同一個 Promise）；只快取成功的結果 */
export function cachedBy<T>(ttlMs = 120_000, max = 200, now: () => number = Date.now) {
  const m = new Map<string, { at: number; p: Promise<T | null> }>();
  return async (key: string, make: () => Promise<T | null>): Promise<T | null> => {
    const t = now();
    const hit = m.get(key);
    if (hit && t - hit.at < ttlMs) { stats.cache_hits++; return await hit.p; }
    const p = make();
    m.set(key, { at: t, p });
    if (m.size > max) for (const k of m.keys()) { if (m.size <= max) break; m.delete(k); }
    const r = await p;
    if (r === null && m.get(key)?.p === p) m.delete(key); // 失敗不快取，下一位讀者可重試
    return r;
  };
}

// ── Jev 實作：POST JEV_URL，Bearer JEV_KEY，body {model, state, questions}，回 {answers:{id:{type:"noul",noul:0..1}}}（介面同 Irori 的 jev.ts，見其 docs/JEV.md）──
const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
export function jevRequestBody(input: RankInput, model: string) {
  const ids = input.candidates.map((c) => c.id);
  const questions: Record<string, unknown> = {};
  input.candidates.forEach((c, i) => {
    questions[`c${i}`] = {
      type: "noul",
      instructions:
        "`新訊息` was just posted in a group chat that has several AI partners and humans. All of the AI partners listed in `被叫醒的夥伴` were notified. " +
        `Should the AI partner named \`${clip(c.label, 60)}\` be the one to answer it now (rather than leaving it to the others)? ` +
        "Judge by the partner's name and role as it appears in the name, whether the message is addressed to it, and whether it is the best fit to answer.",
      criteria: {
        true: "Yes: the message is addressed to this partner, or its topic fits this partner best, or nobody else is better placed to answer",
        false: "No: the message is meant for another partner or for a human, or it needs no reply from this partner (greeting, thanks, status chatter), or another partner is clearly better placed",
      },
    };
  });
  return {
    model,
    state: {
      先前的訊息: input.recent.slice(-RECENT_MSGS).map((m) => `${clip(m.from, 40)}：${clip(m.body, BODY_CHARS)}`).join("\n") || "（沒有）",
      新訊息: clip(input.body, BODY_CHARS * 2),
      ...(input.mentioned?.length ? { 被點名的夥伴: input.mentioned.join("、") } : {}),
      被叫醒的夥伴: ids.join("、"),
    },
    questions,
  };
}

export function makeJevScorer(o: { url: string; key: string; model?: string; timeoutMs?: number; fetch?: typeof fetch }): RankScorer {
  const f = o.fetch ?? ((i, init) => fetch(i, init));
  return async (input) => {
    const r = await f(o.url, {
      method: "POST",
      headers: { authorization: `Bearer ${o.key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(jevRequestBody(input, o.model ?? DEFAULT_MODEL)),
      signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new Error(`http ${r.status}`); }
    const body = await r.json();
    const out: Record<string, number> = {};
    input.candidates.forEach((c, i) => {
      const a = body?.answers?.[`c${i}`];
      if (!a || a.type !== "noul" || typeof a.noul !== "number" || !(a.noul >= 0 && a.noul <= 1)) throw new Error("bad_format");
      out[c.id] = a.noul;
    });
    return out;
  };
}

export type RoomRank = { cfg: RankConfig; score: (key: string, input: RankInput) => Promise<Record<string, number> | null> };
/** 由環境變數組出排序判斷；沒開（JEV_RANK_ENABLED）回 null＝完全走固定順位。開了但缺 JEV_URL／JEV_KEY：每次回 null 並記「unset」 */
export function rankFromEnv(get: Getenv = realEnv, fetchImpl?: typeof fetch): RoomRank | null {
  const cfg = rankConfig(get);
  if (!cfg.enabled) return null;
  const url = (get("JEV_URL") ?? "").trim();
  const key = (get("JEV_KEY") ?? "").trim();
  const scorer = url && key ? makeJevScorer({ url, key, model: get("JEV_MODEL")?.trim() || DEFAULT_MODEL, timeoutMs: cfg.timeoutMs, fetch: fetchImpl }) : null;
  const cache = cachedBy<Record<string, number>>();
  return { cfg, score: (k, input) => cache(k, () => scoreWake(scorer, input, cfg)) };
}
