// 多設備對話連貫（#108）：以帳號而非設備為「我」。設計見 docs/design/ACCOUNT-ME.md。
// 這個檔案做三件事（規則本身在資料庫，migration 20261022020000_account_me.sql）：
//   1. send 的 as_person：只有「本人簽章有效」且信裡明說 as_person=true 才把這個參數傳給資料庫；舊用戶端不說，行為與以前完全相同。
//      資料庫還沒套用新版函式（找不到九個參數的版本）時，退回不帶 p_as_person 重呼叫，信照舊寄出（部署順序顛倒也不壞）。
//   2. 扇出後的門鈴：回信可能同時寄給好幾台設備，資料庫回 bell_topics，每個都要敲。
//   3. chat_history：向後台取「我和某夥伴」90 天內的往來。必須帶本人簽章（x-asn-user）：節點金鑰 AI 視窗也拿得到，
//      但登入憑證只在 ASN 的 Rust 端，所以只有本人的 ASN 讀得到人與所有夥伴的往來。
import type { AuthUser } from "./account.ts";
import { signedUserId } from "./owner_sign.ts";

export type RpcFn = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;

/** 資料庫還沒套用這支函式／這組參數（PostgREST 找不到函式／Postgres 42883） */
export function rpcMissing(e: unknown): boolean {
  const o = e as { code?: unknown; message?: unknown } | null;
  if (!o) return false;
  if (o.code === "PGRST202" || o.code === "42883") return true;
  return typeof o.message === "string" && /could not find the function/i.test(o.message);
}

/** as_person 只認布林 true，且要有本人簽章才傳；其餘一律不傳（資料庫預設 false） */
export function personArgs(asPerson: unknown, signedUser: string | null): Record<string, boolean> {
  return asPerson === true && signedUser ? { p_as_person: true } : {};
}

/** 寄信：帶了 p_as_person 卻遇到舊版函式（找不到）→ 退回不帶重呼叫一次 */
export async function sendWithPerson(
  rpc: RpcFn,
  args: Record<string, unknown>,
): Promise<{ data: unknown; error: unknown }> {
  const r = await rpc("asn_relay_send", args);
  if (r.error && "p_as_person" in args && rpcMissing(r.error)) {
    const { p_as_person: _drop, ...rest } = args;
    return await rpc("asn_relay_send", rest);
  }
  return r;
}

/** 寄信成功後要敲的門鈴：扇出時資料庫回 bell_topics（去重）；舊版只有 bell_topic */
export function bellTopicsOf(data: unknown): string[] {
  const d = data as { bell_topic?: unknown; bell_topics?: unknown } | null;
  const list = Array.isArray(d?.bell_topics) ? d!.bell_topics : [d?.bell_topic];
  return [...new Set(list.filter((t): t is string => typeof t === "string" && t.length > 0))];
}

const NODE_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const HISTORY_DEFAULT = 100;
export const HISTORY_MAX = 200;

export interface HistoryQuery {
  node: string;
  agent: string | null;
  limit: number;
  /** 夥伴 ID（#153，選填）：格式不對當沒帶；有就以「帳號＋夥伴 ID」查，改名前後的往來都拿得到 */
  partnerId: string | null;
  /** 往上捲載入更舊的信：只要早於這個時間（ISO，標準化成毫秒精度）的；沒帶或格式不對＝不出現這個鍵（行為與從前相同） */
  before?: string;
}

const PARTNER_ID_RE = /^p_[0-9a-f]{20}$/;
const BEFORE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** 「早於」的時間：ISO 格式且是真的時間才收，標準化成 UTC 毫秒；其餘當沒帶（不拒絕整個請求） */
export function parseBefore(v: unknown): string | null {
  if (typeof v !== "string" || !BEFORE_RE.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** 夥伴的節點與視窗名（視窗名可空＝找總機）；格式不對回 null */
export function parseHistoryQuery(b: unknown): HistoryQuery | null {
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  if (typeof o.node !== "string" || !NODE_RE.test(o.node)) return null;
  let agent: string | null = null;
  if (o.agent !== undefined && o.agent !== null && o.agent !== "") {
    if (typeof o.agent !== "string" || o.agent.length > 100 || /[\u0000-\u001f\u007f]/.test(o.agent)) return null;
    agent = o.agent;
  }
  let limit = HISTORY_DEFAULT;
  if (o.limit !== undefined) {
    if (typeof o.limit !== "number" || !Number.isInteger(o.limit) || o.limit < 1) return null;
    limit = Math.min(o.limit, HISTORY_MAX);
  }
  const partnerId = typeof o.partner_id === "string" && PARTNER_ID_RE.test(o.partner_id) ? o.partner_id : null;
  const before = parseBefore(o.before);
  return { node: o.node, agent, limit, partnerId, ...(before ? { before } : {}) };
}

export interface HistoryDeps {
  rpc: RpcFn;
  verifyJwt: (token: string) => Promise<AuthUser | null>;
  /** 回傳的信附上附件資訊（與收信同一支） */
  withAttachments: (messages: unknown) => Promise<unknown>;
}

export async function handleChatHistory(
  deps: HistoryDeps,
  me: { id: string },
  signHeader: string | null,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const q = parseHistoryQuery(body);
  if (!q) return { status: 400, body: { error: "bad_request" } };
  const user = await signedUserId(deps.verifyJwt, signHeader);
  if (!user) return { status: 401, body: { error: "unauthorized" } };
  const args: Record<string, unknown> = {
    p_user: user, p_node: me.id, p_partner_node: q.node, p_partner_agent: q.agent, p_limit: q.limit,
  };
  if (q.partnerId) args.p_partner_id = q.partnerId;
  if (q.before) args.p_before = q.before;   // 只在有帶時才傳：沒帶時呼叫與從前完全相同（資料庫還沒套用新參數也不壞）
  let { data, error } = await deps.rpc("asn_chat_history", args);
  // 資料庫還沒套用第六個參數的版本（找不到函式）：退回不帶夥伴 ID 重呼叫，只用名字比對（順序顛倒也不壞）
  if (error && q.partnerId && rpcMissing(error)) {
    delete args.p_partner_id;
    ({ data, error } = await deps.rpc("asn_chat_history", args));
  }
  if (error) {
    if (rpcMissing(error)) return { status: 404, body: { error: "not_found" } };
    console.error(error);
    return { status: 500, body: { error: "internal" } };
  }
  const d = data as { error?: string; messages?: unknown } | null;
  if (d?.error === "forbidden") return { status: 403, body: { error: "forbidden" } };
  if (d?.error) return { status: 400, body: { error: d.error } };
  return { status: 200, body: { messages: await deps.withAttachments(Array.isArray(d?.messages) ? d!.messages : []) } };
}
