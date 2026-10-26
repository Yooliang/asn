// 手機確認終端送字／代答（#285、#439）：桌面建立請求、手機（本人簽章）決定、桌面領取並回報。
// 資料庫函式見 migrations/20261026400000_term_requests.sql。這支只做參數檢查與轉送：
//   節點金鑰的動作（桌面）：term_req_create（建立）、term_req_take（領取已確認的）、term_req_result（回報結果）
//   本人簽章的動作（手機）：term_req_list（列待確認）、term_req_decide（確認或拒絕）；沒簽章一律 forbidden
// 手機只能「決定」，不能建立也不能改內容；雜湊由桌面算、手機原樣帶回，資料庫比對；預覽只放前 200 字且完成後清空。
export type Json = Record<string, any>;
export type Reply = { status: number; body: Json };
export type TermReqDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: Json | null; error: unknown }>;
  ring: (topic: string) => Promise<void>;
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HASH_RE = /^[0-9a-f]{64}$/;
const TERM_ID_RE = /^[A-Za-z0-9_-]{1,16}$/;

const ERROR_TEXT: Record<string, string> = {
  forbidden: "只有使用者本人（簽章）能確認終端請求",
  not_found: "找不到這筆請求（已處理、已過期或不是你的）",
  bad_request: "資料格式不對",
  bad_choice: "選的項目不在這筆請求的選項裡",
  hash_mismatch: "內容已經變了，請重新整理後再確認",
  busy: "這個終端還有一筆請求在處理中",
  rate_limited: "請求太多次了，請稍後再試",
};
const STATUS: Record<string, number> = { forbidden: 403, not_found: 404, bad_request: 400, bad_choice: 400, hash_mismatch: 409, busy: 409, rate_limited: 429 };
export const fail = (code: string): Reply => ({ status: STATUS[code] ?? 400, body: { error: code, detail: ERROR_TEXT[code] ?? code } });

async function call(deps: TermReqDeps, fn: string, args: Record<string, unknown>): Promise<{ data: Json } | Reply> {
  const { data, error } = await deps.rpc(fn, args);
  if (error) {
    console.error(fn, error);
    return fail("internal");
  }
  if (data && typeof data === "object" && !Array.isArray(data) && typeof (data as Json).error === "string") return fail((data as Json).error);
  return { data: data ?? {} };
}
const isReply = (x: { data: Json } | Reply): x is Reply => "status" in x;

// 桌面建立請求的參數檢查：只留認得的欄位，多餘的（command、token…）一律丟掉
export function parseCreate(b: Json): { kind: string; term_id: string; folder_label: string; preview: string; enter: boolean; options: { n: number; label: string }[] | null; hash: string } | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  if (b.kind !== "send" && b.kind !== "answer") return null;
  if (typeof b.term_id !== "string" || !TERM_ID_RE.test(b.term_id)) return null;
  if (typeof b.preview !== "string" || b.preview.trim().length === 0 || b.preview.length > 2000) return null;
  if (b.folder_label != null && (typeof b.folder_label !== "string" || b.folder_label.length > 500)) return null;
  if (b.enter != null && typeof b.enter !== "boolean") return null;
  if (typeof b.hash !== "string" || !HASH_RE.test(b.hash)) return null;
  let options: { n: number; label: string }[] | null = null;
  if (b.kind === "answer") {
    if (!Array.isArray(b.options) || b.options.length < 1 || b.options.length > 12) return null;
    options = [];
    for (const o of b.options) {
      if (!o || typeof o !== "object" || !Number.isInteger(o.n) || o.n < 0 || o.n > 99 || typeof o.label !== "string") return null;
      options.push({ n: o.n, label: o.label.slice(0, 200) });
    }
  } else if (b.options != null) {
    return null;
  }
  return { kind: b.kind, term_id: b.term_id, folder_label: typeof b.folder_label === "string" ? b.folder_label : "", preview: b.preview, enter: b.enter === true, options, hash: b.hash };
}

export async function handleTermReqAction(deps: TermReqDeps, me: { id: string }, action: string, params: Json, signedUser: string | null = null): Promise<Reply> {
  if (action === "term_req_create") {
    const c = parseCreate(params);
    if (!c) return fail("bad_request");
    const r = await call(deps, "asn_relay_term_req_create", {
      p_node: me.id, p_kind: c.kind, p_term_id: c.term_id, p_folder_label: c.folder_label, p_preview: c.preview, p_enter: c.enter, p_options: c.options, p_hash: c.hash,
    });
    if (isReply(r)) return r;
    if (typeof r.data.bell_topic === "string") await deps.ring(r.data.bell_topic);   // 通知只敲門鈴，不帶任何內容
    return { status: 200, body: { id: r.data.id, expires_at: r.data.expires_at } };
  }
  if (action === "term_req_take") {
    const r = await call(deps, "asn_relay_term_req_take", { p_node: me.id });
    return isReply(r) ? r : { status: 200, body: { requests: r.data.requests ?? [], closed: r.data.closed ?? [] } };
  }
  if (action === "term_req_result") {
    const { id, status, detail } = params ?? {};
    if (typeof id !== "string" || !UUID_RE.test(id) || !["done", "failed", "cancelled"].includes(status)) return fail("bad_request");
    const r = await call(deps, "asn_relay_term_req_result", { p_node: me.id, p_id: id, p_status: status, p_detail: typeof detail === "string" ? detail.slice(0, 200) : null });
    return isReply(r) ? r : { status: 200, body: { ok: true } };
  }
  if (action === "term_req_list") {
    if (!signedUser) return fail("forbidden");
    const r = await call(deps, "asn_relay_term_req_list", { p_actor: me.id, p_signed_user: signedUser });
    return isReply(r) ? r : { status: 200, body: { requests: r.data.requests ?? [] } };
  }
  if (action === "term_req_decide") {
    if (!signedUser) return fail("forbidden");
    const { id, decision, choice_n, hash } = params ?? {};
    if (typeof id !== "string" || !UUID_RE.test(id) || (decision !== "approve" && decision !== "deny") || typeof hash !== "string" || !HASH_RE.test(hash)) return fail("bad_request");
    if (choice_n != null && (!Number.isInteger(choice_n) || choice_n < 0 || choice_n > 99)) return fail("bad_request");
    const r = await call(deps, "asn_relay_term_req_decide", { p_actor: me.id, p_signed_user: signedUser, p_id: id, p_decision: decision, p_choice_n: choice_n ?? null, p_hash: hash });
    return isReply(r) ? r : { status: 200, body: { ok: true, status: r.data.status } };
  }
  return { status: 404, body: { error: "not_found" } };
}
export const TERM_REQ_ACTIONS = new Set(["term_req_create", "term_req_take", "term_req_result", "term_req_list", "term_req_decide"]);
export const TERM_REQ_SIGNED_ACTIONS = new Set(["term_req_list", "term_req_decide"]);
