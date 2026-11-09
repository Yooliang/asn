// 通知集中 PR-D（#848）：橋自己寄的通知由後台以「ASN 通知」寄出（relay?action=bridge_notice，節點金鑰）。
// 用戶端只給「回覆哪一封信」和內文；收件人、寄件名、kind、第一行的設備名都由資料庫函式 asn_relay_send_bridge_notice 決定。
// 回應：
//  - 200 { ok, notify: sent | per_mail_limit | rate_limited | failed, id? }
//  - 409 cross_account：原寄件人是別的帳號，橋照舊用「<節點>-收發室」寄
//  - 422 no_origin／is_notice：找不到可回的原信（不是寄給這台、超過 24 小時），或原信本身是通知
//  - 400 bad_request／bad_body、403 forbidden、500 internal
// 舊後台沒有這個動作會回 404 not_found，橋收到 404 也照舊寄。

export type BridgeNoticeDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  ring: (topic: string) => Promise<void>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 20000;

/** 只收 reply_to 與 body；其他欄位（收件人、寄件名、kind）一律不看 */
export function parseBridgeNotice(b: unknown): { replyTo: string; body: string } | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const o = b as Record<string, unknown>;
  if (typeof o.reply_to !== "string" || !UUID.test(o.reply_to)) return null;
  if (typeof o.body !== "string" || o.body.length < 1 || o.body.length > MAX_BODY) return null;
  return { replyTo: o.reply_to, body: o.body };
}

const STATUS: Record<string, number> = {
  bad_request: 400,
  bad_body: 400,
  forbidden: 403,
  cross_account: 409,
  no_origin: 422,
  is_notice: 422,
};

export async function handleBridgeNotice(deps: BridgeNoticeDeps, node: string, raw: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const p = parseBridgeNotice(raw);
  if (!p) return { status: 400, body: { error: "bad_request" } };
  const { data, error } = await deps.rpc("asn_relay_send_bridge_notice", { p_node: node, p_reply_to: p.replyTo, p_body: p.body });
  if (error) {
    console.error(error);
    return { status: 500, body: { error: "internal" } };
  }
  const d = (data ?? {}) as Record<string, unknown>;
  if (typeof d.error === "string") return { status: STATUS[d.error] ?? 400, body: { error: STATUS[d.error] ? d.error : "bad_request" } };
  const notify = typeof d.notify === "string" ? d.notify : "failed";
  if (notify !== "sent") console.warn("bridge_notice notify", node, notify);
  const topics = Array.isArray(d.bell_topics) ? d.bell_topics : [];
  for (const t of new Set(topics.filter((t: unknown): t is string => typeof t === "string" && t.length > 0))) await deps.ring(t);
  const id = typeof d.id === "string" ? d.id : undefined;
  // 不推播：FCM 第一版只推「寄給本人」和「夥伴在等你」，橋通知太頻繁（asn真 11-09）
  return { status: 200, body: id ? { ok: true, notify, id } : { ok: true, notify } };
}
