// 「壓縮 N 次自動交接」（#1852）的次數：2～10，缺值或不是數字用預設 3。跟 Rust（bridge/compact.rs 的 clamp_n）認的範圍一樣。
export const COMPACT_N_MIN = 2
export const COMPACT_N_MAX = 10
export const COMPACT_N_DEFAULT = 3

/** 夾在 2～10；不是數字就用 fallback（呼叫端給目前的值），fallback 也不合就是 3 */
export function clampCompactN(v, fallback = COMPACT_N_DEFAULT) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) return Number.isInteger(fallback) ? Math.min(Math.max(fallback, COMPACT_N_MIN), COMPACT_N_MAX) : COMPACT_N_DEFAULT
  return Math.min(Math.max(Math.round(n), COMPACT_N_MIN), COMPACT_N_MAX)
}
