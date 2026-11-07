// 設備金鑰（#597 別台看畫面，0.2.8 改版：不再手動配對）。資料庫函式見 migrations/20261107100000_device_keys.sql、20261107130000_device_key_alert.sql。
// 這支只做參數檢查與轉送，都用節點金鑰：
//   device_key_publish：上傳自己的設備公鑰
//   device_key_alert：本機記住了別台的公鑰（first，只有被看的那台寄）或發現公鑰換了（changed），通知本人；收件人和文字都在後台決定
// 後台只轉交公鑰，不判斷信任：信任只看各台本機記住的（TOFU）。
import { fail, type Json, type Reply } from "./term_request.ts";

export type DevicePairDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: Json | null; error: unknown }>;
  ring: (topic: string) => Promise<void>;
};

const PUB_RE = /^[A-Za-z0-9_-]{43}$/;
const NODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FP_RE = /^[0-9a-f]{16,32}$/;
const ALERT_KINDS = ["first", "changed"];

const EXTRA_STATUS: Record<string, Reply> = {};

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

export async function handleDevicePairAction(deps: DevicePairDeps, me: { id: string }, action: string, params: Json, _signedUser: string | null): Promise<Reply> {
  const b = params ?? {};
  if (action === "device_key_publish") {
    if (typeof b.sign_pub !== "string" || !PUB_RE.test(b.sign_pub)) return fail("bad_request");
    const r = await call(deps, "asn_relay_device_key_publish", { p_node: me.id, p_sign_pub: b.sign_pub });
    return isReply(r) ? r : { status: 200, body: { ok: true } };
  }
  if (action === "device_key_alert") {
    if (typeof b.peer !== "string" || !NODE_RE.test(b.peer) || !ALERT_KINDS.includes(b.kind) || typeof b.fp !== "string" || !FP_RE.test(b.fp)) return fail("bad_request");
    const r = await call(deps, "asn_relay_device_key_alert", { p_node: me.id, p_peer: b.peer, p_kind: b.kind, p_fp: b.fp });
    if (isReply(r)) return r;
    const topics = Array.isArray(r.data.bell_topics) ? r.data.bell_topics.filter((t: unknown) => typeof t === "string") : [];
    await Promise.all(topics.map((t: string) => deps.ring(t)));
    return { status: 200, body: { notify: r.data.notify } };
  }
  return { status: 404, body: { error: "not_found" } };
}

export const DEVICE_PAIR_ACTIONS = new Set(["device_key_publish", "device_key_alert"]);
// 改版後沒有要本人簽章的動作了（留著這個集合，relay/index.ts 的接法不用改）
export const DEVICE_PAIR_SIGNED_ACTIONS = new Set<string>();
