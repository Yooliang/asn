// 手機回答 Claude 夥伴的權限框（#853）。資料庫函式見 migrations/20261105130000_perm_requests.sql。這支只做參數檢查與轉送：
//   節點金鑰的動作（電腦）：perm_req_create、perm_req_take、perm_req_result
//   本人簽章的動作（手機）：perm_req_list、perm_req_decide；沒簽章一律 403
// 手機只能選選項，不能建立、不能改內容，也沒有欄位能放要送的文字。通知只敲門鈴，不帶內容。
import { fail, HASH_RE, type Json, type Reply, UUID_RE } from "./term_request.ts";

export type PermReqDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: Json | null; error: unknown }>;
  ring: (topic: string) => Promise<void>;
  /** 建立成功（新增了一筆）後呼叫，參數是請求編號；用來推播「需要你確認」。沒給就不推 */
  onCreated?: (id: string) => void;
};

export const TEXT_MAX = 16000;
const WINDOW_MAX = 64;
const LABEL_MAX = 200;
const OPTIONS_MAX = 9;
const DETAIL_MAX = 200;
const NOT_DONE: Reply = { status: 404, body: { error: "not_found" } };

export type PermCreate = { window_name: string; prompt_text: string; complete: boolean; options: { n: number; label: string }[]; hash: string };

/** 電腦建立請求的參數檢查：只留認得的欄位，多餘的一律丟掉 */
export function parseCreate(b: Json): PermCreate | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const { window_name: name, prompt_text: text, complete, options, hash } = b;
  if (typeof name !== "string" || name.length < 1 || name.length > WINDOW_MAX) return null;
  if (typeof text !== "string" || text.trim().length === 0 || text.length > TEXT_MAX) return null;
  if (typeof complete !== "boolean") return null;
  if (typeof hash !== "string" || !HASH_RE.test(hash)) return null;
  if (!Array.isArray(options) || options.length > OPTIONS_MAX) return null;
  const opts: { n: number; label: string }[] = [];
  for (const o of options) {
    if (!o || typeof o !== "object" || !Number.isInteger(o.n) || o.n < 1 || o.n > 9 || typeof o.label !== "string" || o.label.trim().length === 0) return null;
    opts.push({ n: o.n, label: o.label.slice(0, LABEL_MAX) });
  }
  return { window_name: name, prompt_text: text, complete, options: opts, hash };
}

async function call(deps: PermReqDeps, fn: string, args: Record<string, unknown>): Promise<{ data: Json } | Reply> {
  const { data, error } = await deps.rpc(fn, args);
  if (error) {
    console.error(fn, error);   // 只記錯誤，不記參數：參數裡有權限框全文
    return fail("internal");
  }
  if (data && typeof data === "object" && !Array.isArray(data) && typeof (data as Json).error === "string") return fail((data as Json).error);
  return { data: data ?? {} };
}
const isReply = (x: { data: Json } | Reply): x is Reply => "status" in x;

export async function handlePermReqAction(deps: PermReqDeps, me: { id: string }, action: string, params: Json, signedUser: string | null): Promise<Reply> {
  if (action === "perm_req_create") {
    const c = parseCreate(params);
    if (!c) return fail("bad_request");
    const r = await call(deps, "asn_relay_perm_req_create", {
      p_node: me.id, p_window_name: c.window_name, p_prompt_text: c.prompt_text, p_complete: c.complete, p_options: c.options, p_hash: c.hash,
    });
    if (isReply(r)) return r;
    const topics = Array.isArray(r.data.bell_topics) ? r.data.bell_topics.filter((t: unknown) => typeof t === "string") : [];
    await Promise.all(topics.map((t: string) => deps.ring(t)));
    if (typeof r.data.id === "string") deps.onCreated?.(r.data.id);   // 重複的畫面會回 busy（上面已回傳），能走到這裡＝新增了一筆
    return { status: 200, body: { id: r.data.id, expires_at: r.data.expires_at } };
  }
  if (action === "perm_req_take") {
    const r = await call(deps, "asn_relay_perm_req_take", { p_node: me.id });
    return isReply(r) ? r : { status: 200, body: { requests: r.data.requests ?? [], closed: r.data.closed ?? [] } };
  }
  if (action === "perm_req_result") {
    const { id, status, detail } = params ?? {};
    if (typeof id !== "string" || !UUID_RE.test(id) || !["done", "failed", "cancelled"].includes(status)) return fail("bad_request");
    const r = await call(deps, "asn_relay_perm_req_result", { p_node: me.id, p_id: id, p_status: status, p_detail: typeof detail === "string" ? detail.slice(0, DETAIL_MAX) : null });
    return isReply(r) ? r : { status: 200, body: { ok: true } };
  }
  if (action === "perm_req_list") {
    if (!signedUser) return fail("forbidden");
    const r = await call(deps, "asn_relay_perm_req_list", { p_actor: me.id, p_signed_user: signedUser });
    return isReply(r) ? r : { status: 200, body: { requests: r.data.requests ?? [], recent: r.data.recent ?? [] } };
  }
  if (action === "perm_req_decide") {
    if (!signedUser) return fail("forbidden");
    const { id, choice_n, hash } = params ?? {};
    if (typeof id !== "string" || !UUID_RE.test(id) || typeof hash !== "string" || !HASH_RE.test(hash) || !Number.isInteger(choice_n) || choice_n < 1 || choice_n > 9) return fail("bad_request");
    const r = await call(deps, "asn_relay_perm_req_decide", { p_actor: me.id, p_signed_user: signedUser, p_id: id, p_choice_n: choice_n, p_hash: hash });
    return isReply(r) ? r : { status: 200, body: { ok: true, status: r.data.status } };
  }
  return NOT_DONE;
}

export const PERM_REQ_ACTIONS = new Set(["perm_req_create", "perm_req_take", "perm_req_result", "perm_req_list", "perm_req_decide"]);
export const PERM_REQ_SIGNED_ACTIONS = new Set(["perm_req_list", "perm_req_decide"]);
