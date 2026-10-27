// 0.2 H2：機器橋附在名單回報的平台與「不開放開新夥伴」的原因（選填 platform／launch_closed_reason）。
// 平台只收固定幾個值，其餘當 null；原因會顯示在同帳號其他設備的開新夥伴精靈上，只留純文字：控制字元換空白、去頭尾空白、最多 120 字。
// 資料庫（asn_relay_set_platform）會再檢查一次。

export const PLATFORMS = ["linux", "windows", "macos"] as const;
export const CLOSED_REASON_MAX = 120;

export type NodePlatform = { platform: string | null; reason: string | null };

export function sanitizeNodePlatform(b: Record<string, unknown>): NodePlatform {
  const p = typeof b.platform === "string" && (PLATFORMS as readonly string[]).includes(b.platform) ? b.platform : null;
  let reason: string | null = null;
  if (typeof b.launch_closed_reason === "string") {
    // deno-lint-ignore no-control-regex
    const r = b.launch_closed_reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
    reason = r ? [...r].slice(0, CLOSED_REASON_MAX).join("").trim() : null;
  }
  return { platform: p, reason };
}
