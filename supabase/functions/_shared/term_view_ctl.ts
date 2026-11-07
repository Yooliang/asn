// 別台看畫面的控制面（#597 工作包 E）。資料庫函式見 migrations/20261107110000_term_views.sql。這支只做參數檢查與轉送：
//   本人簽章（看的那台 D）：term_view_start、term_view_report
//   節點金鑰（被看的那台 T，可能沒人在）：term_view_pending、term_view_accept、term_view_notice、term_view_stop
// 沒有畫面內容，也沒有自由欄位：多餘的欄位一律丟掉。信任由兩端用本機記的公鑰判斷，後台不驗簽章。
import { fail, type Json, type Reply, UUID_RE } from "./term_request.ts";

export type TermViewDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: Json | null; error: unknown }>;
  ring: (topic: string) => Promise<void>;
};

const PUB_RE = /^[A-Za-z0-9_-]{43}$/;
const D_SIG_RE = /^[A-Za-z0-9_-]{86,700}$/;   // 看的那台用設備金鑰（Ed25519，86 字）；上限和資料庫函式一致，不另外收緊
const T_SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const NODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WINDOW_MAX = 64;
const STOP_REASONS = ["target_ended", "rejected", "viewer_gone", "failed"];
const REPORT_STATES = ["watching", "paused", "ended"];
// 看畫面／打字（0.2.10）。沒帶就是看畫面；範圍兩端簽進握手，這裡只轉交
const SCOPES = ["view", "input"];

async function call(deps: TermViewDeps, fn: string, args: Record<string, unknown>): Promise<{ data: Json } | Reply> {
  const { data, error } = await deps.rpc(fn, args);
  if (error) {
    console.error(fn, error);
    return fail("internal");
  }
  if (data && typeof data === "object" && !Array.isArray(data) && typeof (data as Json).error === "string") return fail((data as Json).error);
  return { data: data ?? {} };
}
const isReply = (x: { data: Json } | Reply): x is Reply => "status" in x;

export async function handleTermViewAction(deps: TermViewDeps, me: { id: string }, action: string, params: Json, signedUser: string | null): Promise<Reply> {
  const b = params ?? {};
  if (action === "term_view_pending") {
    const r = await call(deps, "asn_relay_term_view_pending", { p_node: me.id });
    return isReply(r) ? r : { status: 200, body: { requests: r.data.requests ?? [], active: r.data.active ?? [] } };
  }
  if (action === "term_view_accept") {
    if (typeof b.id !== "string" || !UUID_RE.test(b.id) || typeof b.t_eph_pub !== "string" || !PUB_RE.test(b.t_eph_pub) || typeof b.t_sig !== "string" || !T_SIG_RE.test(b.t_sig)) return fail("bad_request");
    const r = await call(deps, "asn_relay_term_view_accept", { p_node: me.id, p_id: b.id, p_t_eph_pub: b.t_eph_pub, p_t_sig: b.t_sig });
    return isReply(r) ? r : { status: 200, body: { ok: true } };
  }
  if (action === "term_view_notice") {
    if (typeof b.id !== "string" || !UUID_RE.test(b.id)) return fail("bad_request");
    const r = await call(deps, "asn_relay_term_view_notice", { p_node: me.id, p_id: b.id });
    if (isReply(r)) return r;
    const topics = Array.isArray(r.data.bell_topics) ? r.data.bell_topics.filter((t: unknown) => typeof t === "string") : [];
    await Promise.all(topics.map((t: string) => deps.ring(t)));
    return { status: 200, body: { notify: r.data.notify } };   // 不是 sent，T 就不傳第一幅
  }
  if (action === "term_view_stop") {
    if (typeof b.id !== "string" || !UUID_RE.test(b.id) || !STOP_REASONS.includes(b.reason)) return fail("bad_request");
    const r = await call(deps, "asn_relay_term_view_stop", { p_node: me.id, p_id: b.id, p_reason: b.reason });
    return isReply(r) ? r : { status: 200, body: { ok: true } };
  }
  if (!signedUser) return fail("forbidden");
  if (action === "term_view_start") {
    const { id, to_node, window_name, d_eph_pub, d_sig, expires_at } = b;
    const scope = b.scope ?? "view";
    if (typeof id !== "string" || !UUID_RE.test(id) || typeof to_node !== "string" || !NODE_RE.test(to_node)
      || typeof window_name !== "string" || window_name.length < 1 || window_name.length > WINDOW_MAX
      || typeof d_eph_pub !== "string" || !PUB_RE.test(d_eph_pub) || typeof d_sig !== "string" || !D_SIG_RE.test(d_sig)
      || typeof expires_at !== "string" || !Number.isFinite(Date.parse(expires_at)) || !SCOPES.includes(scope)) return fail("bad_request");
    const r = await call(deps, "asn_relay_term_view_start", { p_actor: me.id, p_signed_user: signedUser, p_id: id, p_to_node: to_node, p_window_name: window_name, p_d_eph_pub: d_eph_pub, p_d_sig: d_sig, p_expires_at: expires_at, p_scope: scope });
    if (isReply(r)) return r;
    if (typeof r.data.bell_topic === "string") await deps.ring(r.data.bell_topic);
    return { status: 200, body: { id: r.data.id, topic: r.data.topic, to_pub: r.data.to_pub } };   // to_pub：看的那台要和本機記住的比（TOFU）
  }
  if (action === "term_view_report") {
    if (typeof b.id !== "string" || !UUID_RE.test(b.id) || (b.state != null && !REPORT_STATES.includes(b.state))) return fail("bad_request");
    const r = await call(deps, "asn_relay_term_view_report", { p_actor: me.id, p_signed_user: signedUser, p_id: b.id, p_state: b.state ?? null });
    return isReply(r) ? r : { status: 200, body: { status: r.data.status, end_reason: r.data.end_reason ?? null, t_eph_pub: r.data.t_eph_pub ?? null, t_sig: r.data.t_sig ?? null, expires_s: r.data.expires_s ?? null } };
  }
  return { status: 404, body: { error: "not_found" } };
}

export const TERM_VIEW_ACTIONS = new Set(["term_view_start", "term_view_report", "term_view_pending", "term_view_accept", "term_view_notice", "term_view_stop"]);
export const TERM_VIEW_SIGNED_ACTIONS = new Set(["term_view_start", "term_view_report"]);
