// 手機請電腦顯示指紋（#1863）。資料庫函式見 migrations/20261125320000_fp_show_requests.sql。這支只做參數檢查與轉送：
//   本人簽章的動作（手機）：fp_show_request、fp_show_status、fp_show_end；沒簽章一律 403
//   節點金鑰的動作（電腦）：fp_show_take、fp_show_ack
// 指紋與 QR 內容由電腦在本機產生，後台不經手：這裡沒有任何欄位能放它們。門鈴只帶 kind，不帶內容、不帶 node。
import { fail, type Json, type Reply, UUID_RE } from "./term_request.ts";

export type FpShowDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: Json | null; error: unknown }>;
  ring: (topic: string, payload?: Record<string, unknown>) => Promise<void>;
};

const NODE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const DETAIL_MAX = 200;
const NOT_DONE: Reply = { status: 404, body: { error: "not_found" } };

async function call(deps: FpShowDeps, fn: string, args: Record<string, unknown>): Promise<{ data: Json } | Reply> {
  const { data, error } = await deps.rpc(fn, args);
  if (error) {
    console.error(fn, error);
    return fail("internal");
  }
  if (data && typeof data === "object" && !Array.isArray(data) && typeof (data as Json).error === "string") {
    const code = (data as Json).error as string;
    const reply = fail(code);
    // 太頻繁但同一人那台還有一筆進行中的請求：把那筆的編號放在 scope，手機接著查它的狀態，不另外開一筆
    const live = (data as Json).id;
    if (code === "rate_limited" && typeof live === "string" && UUID_RE.test(live)) return { ...reply, body: { ...reply.body, scope: live } };
    return reply;
  }
  return { data: data ?? {} };
}
const isReply = (x: { data: Json } | Reply): x is Reply => "status" in x;

/** 敲「那台電腦」的門鈴：payload 只有 kind（有 node 舊客戶端會當回報門鈴而不叫醒）。bell_topic 是頻道秘密，不放進回給手機的內容。舊資料庫沒回就不敲 */
async function ringTarget(deps: FpShowDeps, topic: unknown): Promise<void> {
  if (typeof topic !== "string") return;
  // 資料已經寫進去了：門鈴失敗不能讓整個請求回 500（手機會一直重送、電腦卻已經跳窗）。吞掉並記 log；電腦視窗開著時本來就每 5 秒自己再領一次
  try {
    await deps.ring(topic, { kind: "fp_show" });
  } catch (e) {
    console.error("fp_show ring failed", String(e));
  }
}

export async function handleFpShowAction(deps: FpShowDeps, me: { id: string }, action: string, params: Json, signedUser: string | null): Promise<Reply> {
  if (action === "fp_show_request") {
    if (!signedUser) return fail("forbidden");
    const target = params?.node;
    if (typeof target !== "string" || !NODE_RE.test(target)) return fail("bad_request");
    const r = await call(deps, "asn_relay_fp_show_request", { p_actor: me.id, p_signed_user: signedUser, p_target: target });
    if (isReply(r)) return r;
    await ringTarget(deps, r.data.bell_topic);
    return { status: 200, body: { id: r.data.id, expires_at: r.data.expires_at } };
  }
  if (action === "fp_show_status") {
    if (!signedUser) return fail("forbidden");
    const id = params?.id;
    if (typeof id !== "string" || !UUID_RE.test(id)) return fail("bad_request");
    const r = await call(deps, "asn_relay_fp_show_status", { p_actor: me.id, p_signed_user: signedUser, p_id: id });
    return isReply(r) ? r : { status: 200, body: { id: r.data.id, status: r.data.status, detail: r.data.detail ?? null, expires_at: r.data.expires_at } };
  }
  if (action === "fp_show_end") {
    if (!signedUser) return fail("forbidden");
    const id = params?.id;
    if (typeof id !== "string" || !UUID_RE.test(id)) return fail("bad_request");
    const r = await call(deps, "asn_relay_fp_show_end", { p_actor: me.id, p_signed_user: signedUser, p_id: id });
    if (isReply(r)) return r;
    await ringTarget(deps, r.data.bell_topic);
    return { status: 200, body: { ok: true, status: r.data.status } };
  }
  if (action === "fp_show_take") {
    const r = await call(deps, "asn_relay_fp_show_take", { p_node: me.id });
    return isReply(r) ? r : { status: 200, body: { requests: r.data.requests ?? [], closed: r.data.closed ?? [] } };
  }
  if (action === "fp_show_ack") {
    const { id, status, detail } = params ?? {};
    if (typeof id !== "string" || !UUID_RE.test(id) || !["shown", "cancelled"].includes(status)) return fail("bad_request");
    const r = await call(deps, "asn_relay_fp_show_ack", { p_node: me.id, p_id: id, p_status: status, p_detail: typeof detail === "string" ? detail.slice(0, DETAIL_MAX) : null });
    return isReply(r) ? r : { status: 200, body: { ok: true } };
  }
  return NOT_DONE;
}

export const FP_SHOW_ACTIONS = new Set(["fp_show_request", "fp_show_status", "fp_show_end", "fp_show_take", "fp_show_ack"]);
export const FP_SHOW_SIGNED_ACTIONS = new Set(["fp_show_request", "fp_show_status", "fp_show_end"]);
