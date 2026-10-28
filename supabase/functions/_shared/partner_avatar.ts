// 夥伴自己換頭像（#446）的 Edge 端：請求內容整理與檢查、資料庫回覆對應成 HTTP 狀態。relay 函式的 set_partner_avatar／partner_avatar 動作用它。
// 規則與 relay.nodes 的設備頭像相同（_shared/avatar.ts 的 checkAvatar：只收 png／webp、圖檔 ≤ 32 KB、全長 ≤ 48000 字、檔頭對得上），
// 資料庫函式與資料表的 check 再各擋一次。節點代號一律取自已驗證的金鑰（呼叫端給），body 裡不接受指定節點。
import { checkAvatar } from "./avatar.ts";

export const PARTNER_ID_RE = /^p_[0-9a-f]{20}$/;
export const AGENT_MAX_CHARS = 100;

export type SetRequest = { ok: true; agent: string; avatar: string | null } | { ok: false; error: string };

export function parseSetPartnerAvatar(b: unknown): SetRequest {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, error: "bad_request" };
  const o = b as Record<string, unknown>;
  const agent = o.agent;
  // deno-lint-ignore no-control-regex
  if (typeof agent !== "string" || agent.length < 1 || agent.length > AGENT_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(agent)) return { ok: false, error: "bad_request" };
  if (!("avatar" in o)) return { ok: false, error: "bad_request" };
  const c = checkAvatar(o.avatar);
  if (!c.ok) return { ok: false, error: c.error };
  return { ok: true, agent, avatar: c.avatar };
}

// asn_relay_set_partner_avatar 的回覆 → { status, body }
export function setReply(data: { error?: string; avatar_updated_at?: string | null; partner_id?: string } | null): { status: number; body: Record<string, unknown> } {
  if (data?.error === "not_found") return { status: 404, body: { error: "partner_not_found" } };   // 不叫 not_found：舊後台對不認得的動作回 not_found，用戶端靠這個分辨「後台太舊」和「找不到這位夥伴」
  if (data?.error === "rate_limited") return { status: 429, body: { error: "rate_limited" } };
  if (data?.error === "bad_avatar") return { status: 400, body: { error: "bad_avatar_format" } };
  if (data?.error) return { status: 400, body: { error: "bad_request" } };
  return { status: 200, body: { ok: true, partner_id: data?.partner_id ?? null, avatar_updated_at: data?.avatar_updated_at ?? null } };
}
