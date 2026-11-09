// 冪等寄信（#1135）：客戶端每封信帶一個 client_id（UUID），重試時沿用；後台在同一個寄件節點內據此去重。
// 沒帶＝舊客戶端，完全走原路徑。格式不對回 400（不默默忽略）。重複送來時回第一次那封的 id、照成功回，不再寄、附件不處理。
import { rpcMissing, type RpcFn, sendWithPerson } from "./account_me.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** undefined／null＝沒帶（舊客戶端）；字串且是 UUID＝有效（統一轉小寫）；其餘＝格式不對（呼叫端回 400 bad_client_id） */
export function parseClientId(v: unknown): { ok: true; id: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, id: null };
  if (typeof v === "string" && UUID_RE.test(v)) return { ok: true, id: v.toLowerCase() };
  return { ok: false };
}

/** 寄信前先認重複：回已寄出那封的 id；沒有、或後台還沒套用查詢函式、或查詢失敗，回 null（之後寄信時資料庫還會再去重一次） */
export async function findSentByClientId(rpc: RpcFn, node: string, clientId: string): Promise<string | null> {
  const { data, error } = await rpc("asn_relay_send_lookup", { p_node: node, p_client_id: clientId });
  if (error) {
    if (!rpcMissing(error)) console.error("send_lookup", error);
    return null;
  }
  const id = (data as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
}

/** 寄信：有 client_id 走 asn_relay_send_idem（資料庫去重）；後台還沒套用（找不到函式）→ 退回一般寄信 */
export async function sendWithClientId(
  rpc: RpcFn,
  clientId: string | null,
  args: Record<string, unknown>,
): Promise<{ data: unknown; error: unknown }> {
  if (!clientId) return await sendWithPerson(rpc, args);
  const r = await rpc("asn_relay_send_idem", { ...args, p_client_id: clientId });
  if (r.error && rpcMissing(r.error)) return await sendWithPerson(rpc, args);
  return r;
}
