// 遠端一次性密碼傳遞（#26 第二期，設計見 docs/design/SECRET-REMOTE.md）共用邏輯。
// 最後一道關在 migrations/20261023060000_secret_remote.sql 的函式（本人簽章、擁有關係、一次性、有效期限、頻率上限）。
// 這裡負責：沒簽章在打資料庫之前就 401、輸入整理與格式檢查、動作分派、錯誤碼對應。
//
// 鐵則（有守門測試）：
//  - 後台只看得到公鑰、用途說明、密文；這個檔案不解密、沒有任何私鑰。
//  - 密文只出現在 secret_reply 的資料庫參數與 secret_fetch 的回應裡；不進 log、不進錯誤訊息。
//  - 資料庫出錯時只記錯誤代碼（error.code），**不記整個錯誤物件**：約束違反的 detail 會把整列內容（含密文）帶出來。

// deno-lint-ignore no-explicit-any
type Json = any;

import type { LaunchDeps, Reply } from "./launch.ts";

export const SECRET_ACTIONS = new Set(["secret_request", "secret_fetch", "secret_pending", "secret_reply"]);
export const TTL_MIN = 30;
export const TTL_MAX = 600;
export const TTL_DEFAULT = 180;
export const PROGRAM_MAX = 80;
export const PURPOSE_MAX = 200;
export const CIPHER_MIN = 100;
export const CIPHER_MAX = 2048;
const PUB_RE = /^[A-Za-z0-9_-]{43}$/;
const CIPHER_RE = /^[A-Za-z0-9_-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ERROR_TEXT: Record<string, string> = {
  unauthorized: "請先登入，才能替自己的設備確認密碼請求",
  forbidden: "只有使用者本人能確認密碼請求",
  not_found: "找不到這筆密碼請求（可能已過期或已處理）",
  not_owned: "這台設備還沒綁定到你的帳號，不能請求遠端密碼",
  too_many: "這台設備同時等待的密碼請求太多了",
  rate_limited: "這台設備這個小時要密碼太多次了，稍後再試",
  expired: "這筆密碼請求已經過期",
  already_answered: "這筆密碼請求已經回覆過了",
  bad_cipher: "密文格式不對",
  bad_request: "資料格式不對",
  internal: "伺服器發生錯誤",
};
export const secretErrorText = (code: string) => ERROR_TEXT[code] ?? "操作失敗";
const STATUS: Record<string, number> = {
  unauthorized: 401, forbidden: 403, not_found: 404, not_owned: 409, too_many: 429, rate_limited: 429, expired: 410, already_answered: 409, internal: 500,
};
export const fail = (code: string): Reply => ({ status: STATUS[code] ?? 400, body: { error: code, detail: secretErrorText(code) } });

const hasControl = (s: string) => /[\u0000-\u001f\u007f‪-‮⁦-⁩]/.test(s);

export type SecretRequest = { pub: string; program: string; purpose: string; ttl: number };

// 第一層格式檢查（不查資料庫）；多餘的欄位一律丟掉
export function parseSecretRequest(b: Json): SecretRequest | { error: string } {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "bad_request" };
  const { pub, program, purpose } = b;
  if (typeof pub !== "string" || !PUB_RE.test(pub)) return { error: "bad_request" };
  if (typeof program !== "string" || program.length < 1 || program.length > PROGRAM_MAX || hasControl(program)) return { error: "bad_request" };
  if (typeof purpose !== "string" || purpose.length < 1 || purpose.length > PURPOSE_MAX || hasControl(purpose)) return { error: "bad_request" };
  let ttl = TTL_DEFAULT;
  if (b.ttl != null) {
    if (typeof b.ttl !== "number" || !Number.isInteger(b.ttl) || b.ttl < TTL_MIN || b.ttl > TTL_MAX) return { error: "bad_request" };
    ttl = b.ttl;
  }
  return { pub, program, purpose, ttl };
}

export type SecretReply = { id: string; cipher: string | null; deny: boolean };
export function parseSecretReply(b: Json): SecretReply | { error: string } {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "bad_request" };
  if (typeof b.id !== "string" || !UUID_RE.test(b.id)) return { error: "bad_request" };
  if (b.deny === true) return { id: b.id, cipher: null, deny: true };
  if (b.deny != null && b.deny !== false) return { error: "bad_request" };
  if (typeof b.cipher !== "string" || b.cipher.length < CIPHER_MIN || b.cipher.length > CIPHER_MAX || !CIPHER_RE.test(b.cipher)) return { error: "bad_cipher" };
  return { id: b.id, cipher: b.cipher, deny: false };
}

// 資料庫呼叫。出錯只記函式名與錯誤代碼，不記錯誤物件（可能夾帶整列資料，包含密文）
async function call(deps: LaunchDeps, fn: string, args: Record<string, unknown>): Promise<{ data: Json } | Reply> {
  const { data, error } = await deps.rpc(fn, args);
  if (error) {
    const code = (error as { code?: unknown } | null)?.code;
    console.error(fn, typeof code === "string" ? code : "error");
    return fail("internal");
  }
  if (data && typeof data === "object" && !Array.isArray(data) && typeof data.error === "string") return fail(data.error);
  return { data };
}
const isReply = (x: { data: Json } | Reply): x is Reply => "status" in x;

// 節點金鑰的動作：
//   secret_request／secret_fetch：請求端（任何有主人的節點）建立請求、取回答
//   secret_pending／secret_reply：本人的設備查待確認的請求、回覆密文或拒絕（**一定要本人簽章**，沒簽章 401 不打資料庫）
export async function handleSecretAction(deps: LaunchDeps, me: { id: string }, action: string, params: Json, signedUser: string | null = null): Promise<Reply> {
  if (action === "secret_request") {
    const req = parseSecretRequest(params);
    if ("error" in req) return fail(req.error);
    const r = await call(deps, "asn_relay_secret_request", {
      p_node: me.id, p_pub: req.pub, p_program: req.program, p_purpose: req.purpose, p_ttl_seconds: req.ttl,
    });
    if (isReply(r)) return r;
    for (const t of Array.isArray(r.data?.bell_topics) ? r.data.bell_topics : []) if (typeof t === "string") await deps.ring(t);
    return { status: 200, body: { id: r.data.id, expires_at: r.data.expires_at } };
  }
  if (action === "secret_fetch") {
    const id = params?.id;
    if (typeof id !== "string" || !UUID_RE.test(id)) return fail("bad_request");
    const r = await call(deps, "asn_relay_secret_fetch", { p_node: me.id, p_id: id });
    if (isReply(r)) return r;
    return { status: 200, body: r.data };
  }
  if (action === "secret_pending") {
    if (!signedUser) return fail("unauthorized");
    const r = await call(deps, "asn_relay_secret_pending", { p_actor: me.id, p_signed_user: signedUser });
    if (isReply(r)) return r;
    return { status: 200, body: r.data };
  }
  if (action === "secret_reply") {
    if (!signedUser) return fail("unauthorized");
    const rep = parseSecretReply(params);
    if ("error" in rep) return fail(rep.error);
    const r = await call(deps, "asn_relay_secret_reply", {
      p_actor: me.id, p_signed_user: signedUser, p_id: rep.id, p_cipher: rep.cipher, p_deny: rep.deny,
    });
    if (isReply(r)) return r;
    if (typeof r.data?.bell_topic === "string") await deps.ring(r.data.bell_topic);
    return { status: 200, body: { ok: true } };
  }
  return { status: 404, body: { error: "not_found" } };
}
