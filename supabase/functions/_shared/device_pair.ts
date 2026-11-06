// 設備配對（#597 工作包 E）。資料庫函式見 migrations/20261107100000_device_pairing.sql、20261107120000_device_pair_view_pub.sql。這支只做參數檢查與轉送：
//   節點金鑰：device_key_publish（上傳自己的設備公鑰）
//   本人簽章：device_pair_start、device_pair_list、device_pair_decide、device_pair_close；沒簽章一律 403
// 後台只轉交公鑰和簽章，不判斷信任：信任只看各台本機記的。通知只敲門鈴，不帶內容。
import { fail, type Json, type Reply, UUID_RE } from "./term_request.ts";

export type DevicePairDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: Json | null; error: unknown }>;
  ring: (topic: string) => Promise<void>;
};

const PUB_RE = /^[A-Za-z0-9_-]{43}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const NODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
// D 的 Hello 公鑰（RSA，PKCS#1 DER 的 base64url）。這裡只看格式和長度，是不是夠長的 RSA 由 T 本機驗
const VIEW_PUB_RE = /^[A-Za-z0-9_-]{200,1400}$/;

const EXTRA_STATUS: Record<string, Reply> = {
  no_key: { status: 409, body: { error: "no_key", detail: "那台電腦的 ASN 版本太舊，還不能配對" } },
};

async function call(deps: DevicePairDeps, fn: string, args: Record<string, unknown>): Promise<{ data: Json } | Reply> {
  const { data, error } = await deps.rpc(fn, args);
  if (error) {
    console.error(fn, error);
    return fail("internal");
  }
  if (data && typeof data === "object" && !Array.isArray(data) && typeof (data as Json).error === "string") {
    return EXTRA_STATUS[(data as Json).error] ?? fail((data as Json).error);
  }
  return { data: data ?? {} };
}
const isReply = (x: { data: Json } | Reply): x is Reply => "status" in x;

export async function handleDevicePairAction(deps: DevicePairDeps, me: { id: string }, action: string, params: Json, signedUser: string | null): Promise<Reply> {
  const b = params ?? {};
  if (action === "device_key_publish") {
    if (typeof b.sign_pub !== "string" || !PUB_RE.test(b.sign_pub)) return fail("bad_request");
    const r = await call(deps, "asn_relay_device_key_publish", { p_node: me.id, p_sign_pub: b.sign_pub });
    return isReply(r) ? r : { status: 200, body: { ok: true } };
  }
  if (!signedUser) return fail("forbidden");
  if (action === "device_pair_start") {
    if (typeof b.to_node !== "string" || !NODE_RE.test(b.to_node) || typeof b.from_pub !== "string" || !PUB_RE.test(b.from_pub)) return fail("bad_request");
    const viewPub = b.from_view_pub ?? null;
    if (viewPub !== null && (typeof viewPub !== "string" || !VIEW_PUB_RE.test(viewPub))) return fail("bad_request");
    const r = await call(deps, "asn_relay_device_pair_start", { p_actor: me.id, p_signed_user: signedUser, p_to_node: b.to_node, p_from_pub: b.from_pub, p_from_view_pub: viewPub });
    if (isReply(r)) return r;
    if (typeof r.data.bell_topic === "string") await deps.ring(r.data.bell_topic);
    return { status: 200, body: { id: r.data.id, to_pub: r.data.to_pub, to_name: r.data.to_name, expires_at: r.data.expires_at } };
  }
  if (action === "device_pair_list") {
    const r = await call(deps, "asn_relay_device_pair_list", { p_actor: me.id, p_signed_user: signedUser });
    return isReply(r) ? r : { status: 200, body: { incoming: r.data.incoming ?? [], outgoing: r.data.outgoing ?? [] } };
  }
  if (action === "device_pair_decide") {
    const { id, decision, sig } = b;
    if (typeof id !== "string" || !UUID_RE.test(id) || (decision !== "confirm" && decision !== "reject")) return fail("bad_request");
    if (decision === "confirm" && (typeof sig !== "string" || !SIG_RE.test(sig))) return fail("bad_request");
    const r = await call(deps, "asn_relay_device_pair_decide", { p_actor: me.id, p_signed_user: signedUser, p_id: id, p_decision: decision, p_sig: decision === "confirm" ? sig : null });
    return isReply(r) ? r : { status: 200, body: { ok: true, status: r.data.status } };
  }
  if (action === "device_pair_close") {
    if (typeof b.id !== "string" || !UUID_RE.test(b.id)) return fail("bad_request");
    const r = await call(deps, "asn_relay_device_pair_close", { p_actor: me.id, p_signed_user: signedUser, p_id: b.id });
    return isReply(r) ? r : { status: 200, body: { ok: true } };
  }
  return { status: 404, body: { error: "not_found" } };
}

export const DEVICE_PAIR_ACTIONS = new Set(["device_key_publish", "device_pair_start", "device_pair_list", "device_pair_decide", "device_pair_close"]);
export const DEVICE_PAIR_SIGNED_ACTIONS = new Set(["device_pair_start", "device_pair_list", "device_pair_decide", "device_pair_close"]);
