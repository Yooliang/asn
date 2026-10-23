// 各台電腦的 ASN 在名單回報裡附上的 Claude 外掛狀態（roster 動作的選填欄位 mod）。
// 只收固定的狀態名稱、版本字串（英數與 . + -，最多 32 字）、簡短原因（最多 120 字、去控制字元）；多餘欄位丟掉。
// 格式不對回 null＝這次不更新外掛狀態，不因此拒絕整份名單（舊版 ASN 沒帶這個欄位也不壞）。

export const MOD_STATES = ["installed", "removed", "no_claude", "failed", "update_failed", "checking"] as const;
export type ClaudeMod = { state: string; version: string | null; reason: string | null };

const VERSION_RE = /^[0-9A-Za-z.+-]{0,32}$/;

export function sanitizeClaudeMod(m: unknown): ClaudeMod | null {
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  if (typeof o.state !== "string" || !(MOD_STATES as readonly string[]).includes(o.state)) return null;
  let version: string | null = null;
  if (o.version != null) {
    if (typeof o.version !== "string" || !VERSION_RE.test(o.version)) return null;
    version = o.version || null;
  }
  let reason: string | null = null;
  if (o.reason != null) {
    if (typeof o.reason !== "string") return null;
    // deno-lint-ignore no-control-regex
    const r = o.reason.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    reason = r ? [...r].slice(0, 120).join("") : null;
  }
  return { state: o.state, version, reason };
}
