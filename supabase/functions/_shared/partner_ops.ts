// 遠端管理夥伴視窗（詳情、改名、切換模型、關閉、轉交下一任；設計見 docs/design/PARTNER-OPS.md）共用邏輯。
// 寫法與 launch.ts 同形：最後一道關在 migrations/20261022120000_partner_ops.sql 的函式（本人簽章、擁有節點、名單、開放、名字、忙碌、每小時上限、保護名單）；
// 這裡負責：沒簽章在打資料庫之前就 401、輸入整理與第一層格式檢查、節點動作的分派、錯誤碼對應。電腦端執行前還會再驗一次。

// deno-lint-ignore no-explicit-any
type Json = any;

import { LAUNCH_NAME_RE, NODE_ID_RE, type LaunchDeps, type Reply } from "./launch.ts";

export const PARTNER_OPS = ["info", "rename", "model", "close", "handover"] as const;
export const NOTE_MAX = 1000;
export const RESULT_MAX_BYTES = 4096;
// 模型字串：1～60 字，只允許英數與 . _ [ ] -（命令列旗標的值，不能夾空白、引號、分號）
export const MODEL_RE = /^[A-Za-z0-9._\[\]-]{1,60}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ERROR_TEXT: Record<string, string> = {
  unauthorized: "請先登入，才能管理夥伴視窗",
  forbidden: "只有使用者本人能管理夥伴視窗",
  not_found: "找不到這個視窗（可能剛關掉，或這台電腦不在線）",
  no_launcher: "這台電腦沒有開放遠端管理視窗",
  bad_name: "新名字只能用英數、連字號、中文，1～40 字，不能以連字號開頭",
  bad_model: "模型名稱只能用英數與 . _ [ ] -，1～60 字",
  bad_note: `補充的話最多 ${NOTE_MAX} 字`,
  name_taken: "這台電腦已經有同名的視窗（或剛用過），換個名字",
  busy: "這個視窗還有一個操作在進行中，等它完成再試",
  rate_limited: "這台電腦這個小時管理太多次了，稍後再試",
  protected: "收發室與 ASN 自己的視窗不能這樣操作",
  bad_request: "資料格式不對",
  internal: "伺服器發生錯誤",
};
export const partnerOpErrorText = (code: string) => ERROR_TEXT[code] ?? "操作失敗";
const STATUS: Record<string, number> = {
  unauthorized: 401, forbidden: 403, protected: 403, not_found: 404, no_launcher: 409, name_taken: 409, busy: 409, rate_limited: 429, internal: 500,
};
export const fail = (code: string): Reply => ({ status: STATUS[code] ?? 400, body: { error: code, detail: partnerOpErrorText(code) } });

export type PartnerOpRequest = {
  node: string; name: string; op: (typeof PARTNER_OPS)[number];
  new_name: string | null; model: string | null; note: string | null;
};

const hasControl = (s: string) => /[\u0000-\u001f\u007f]/.test(s);

// 第一層格式檢查（不查資料庫）；多餘的欄位一律丟掉，只有該動作用得到的欄位會留下
export function parsePartnerOp(b: Json): PartnerOpRequest | { error: string } {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "bad_request" };
  const { node, name, op } = b;
  if (typeof node !== "string" || !NODE_ID_RE.test(node)) return { error: "bad_request" };
  if (typeof name !== "string" || name.length < 1 || name.length > 80 || hasControl(name)) return { error: "bad_request" };
  if (typeof op !== "string" || !(PARTNER_OPS as readonly string[]).includes(op)) return { error: "bad_request" };
  const out: PartnerOpRequest = { node, name, op: op as PartnerOpRequest["op"], new_name: null, model: null, note: null };
  if (op === "rename") {
    if (typeof b.new_name !== "string" || !LAUNCH_NAME_RE.test(b.new_name)) return { error: "bad_name" };
    out.new_name = b.new_name;
  } else if (op === "model") {
    if (typeof b.model !== "string" || !MODEL_RE.test(b.model)) return { error: "bad_model" };
    out.model = b.model;
  } else if (op === "handover" && b.note != null) {
    if (typeof b.note !== "string") return { error: "bad_note" };
    const note = b.note.trim();
    if (note.length > NOTE_MAX) return { error: "bad_note" };
    out.note = note || null;
  }
  return out;
}

async function call(deps: LaunchDeps, fn: string, args: Record<string, unknown>): Promise<{ data: Json } | Reply> {
  const { data, error } = await deps.rpc(fn, args);
  if (error) {
    console.error(fn, error);
    return fail("internal");
  }
  if (data && typeof data === "object" && !Array.isArray(data) && typeof data.error === "string") return fail(data.error);
  return { data };
}
const isReply = (x: { data: Json } | Reply): x is Reply => "status" in x;

// 下令：一定要本人簽章（沒有就 401，不打資料庫）。成功敲目標電腦的門鈴
export async function requestPartnerOp(deps: LaunchDeps, actor: string, raw: Json, signedUser: string | null): Promise<Reply> {
  if (!signedUser) return fail("unauthorized");
  const req = parsePartnerOp(raw);
  if ("error" in req) return fail(req.error);
  const r = await call(deps, "irori_relay_partner_op", {
    p_actor: actor, p_signed_user: signedUser, p_node: req.node, p_name: req.name, p_op: req.op,
    p_new_name: req.new_name, p_model: req.model, p_note: req.note,
  });
  if (isReply(r)) return r;
  await deps.ring(r.data.bell_topic);
  return { status: 200, body: { id: r.data.id } };
}

// 查進度：ids 最多 20 個
export async function listPartnerOps(deps: LaunchDeps, actor: string, ids: unknown, signedUser: string | null): Promise<Reply> {
  if (!signedUser) return fail("unauthorized");
  const list = Array.isArray(ids) ? ids : typeof ids === "string" ? ids.split(",") : null;
  if (!list || list.length < 1 || list.length > 20 || !list.every((i) => typeof i === "string" && UUID_RE.test(i))) return fail("bad_request");
  const r = await call(deps, "irori_relay_partner_ops", { p_actor: actor, p_signed_user: signedUser, p_ids: list });
  if (isReply(r)) return r;
  return { status: 200, body: r.data };
}

// 回報的結果：只收物件（或空），序列化後最多 4 KB
export function sanitizeResult(v: Json): Json | null | { error: string } {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return { error: "bad_request" };
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    return { error: "bad_request" };
  }
  return new TextEncoder().encode(s).length > RESULT_MAX_BYTES ? { error: "bad_request" } : v;
}

// 節點金鑰的動作（irori-relay）：
//   partner_op／partner_ops：手機下令與查進度（要本人簽章，資料庫核對擁有關係）
//   partner_op_pending／partner_op_result：電腦端內建收發室取走自己節點的待辦、回報結果（只動得到自己節點的）
export async function handleNodePartnerOpAction(deps: LaunchDeps, me: { id: string }, action: string, params: Json, signedUser: string | null = null): Promise<Reply> {
  if (action === "partner_op") return await requestPartnerOp(deps, me.id, params, signedUser);
  if (action === "partner_ops") return await listPartnerOps(deps, me.id, params?.ids, signedUser);
  if (action === "partner_op_pending") {
    const r = await call(deps, "irori_relay_partner_op_pending", { p_node: me.id });
    if (isReply(r)) return r;
    return { status: 200, body: { ops: r.data ?? [] } };
  }
  if (action === "partner_op_result") {
    const { id, status, detail, result } = params ?? {};
    if (typeof id !== "string" || !UUID_RE.test(id) || !["ok", "failed", "unconfirmed"].includes(status)) return fail("bad_request");
    const res = sanitizeResult(result);
    if (res && "error" in res) return fail("bad_request");
    const r = await call(deps, "irori_relay_partner_op_result", {
      p_node: me.id, p_id: id, p_status: status, p_detail: typeof detail === "string" ? detail.slice(0, 500) : null, p_result: res,
    });
    if (isReply(r)) return r;
    return { status: 200, body: { ok: true } };
  }
  return { status: 404, body: { error: "not_found" } };
}
export const PARTNER_OP_ACTIONS = new Set(["partner_op", "partner_ops", "partner_op_pending", "partner_op_result"]);
