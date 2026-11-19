// 網頁版的閘道（#1751 第 0 階段）：網頁用「登入身分」打後台，不持有長期金鑰，只能做明確列入的動作。
//
// 請求長相：沒有 x-relay-key，帶 x-asn-user（Bearer 登入憑證）加 x-asn-web（瀏覽器代號，瀏覽器自己產的亂數）。
// 後台每次都重新驗憑證，再核對登入記錄（relay.web_sessions）：記錄裡沒有、已登出、或瀏覽器代號對不上，都不放行。
// 第一次來的登入（且動作有在放行清單內）才會建立網頁節點與登入記錄；新的瀏覽器第一次登入，寄一封信給本人。
//
// 規則：
//   - 放行清單只有明確列入的動作，其餘一律回 403 web_forbidden（預設拒絕）。守門測試比對 index.ts 的所有動作，新動作一定要在「放行」或「禁止」兩份清單之一明列。
//   - 網頁來源（Origin 是網頁版的網域）的請求一律走網頁路線；憑證裡沒有 session_id 一律拒絕。電腦與手機的請求缺 session_id 照舊處理。
//   - 網頁登入的憑證只能走網頁路線，在網頁路線之外一律 403 web_forbidden。
//   - 跨來源許可只給網頁版的網域（設定 ASN_WEB_ORIGINS，逗號分隔；沒設就是空，誰都不給）。
//   - 網頁分支只在請求的 Origin 是設定的網頁版網域時才啟用；沒設網域（站點還沒建）或 Origin 不在清單裡，帶瀏覽器代號一律 403，什麼都不寫。
import { type AuthUser, bearerToken, type Reply } from "./account.ts";
import { SIGN_HEADER } from "./owner_sign.ts";

export const WEB_HEADER = "x-asn-web";
export const WEB_FORBIDDEN = "web_forbidden";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEB_DEVICE = /^[A-Za-z0-9_-]{16,64}$/;

/** 網頁節點可以做的動作。第 0 階段只放讀取類；回信、附件、群組等之後各階段再逐項加入 */
export const WEB_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  "list", // 名單（網頁節點自己傳 p_include_web，看得到其他網頁登入）
  "whoami", // 自己的節點代號與門鈴頻道
  "inbox", // 收自己這個網頁節點的信（只動自己的列）
  "ack", // 確認收到自己的信（資料庫只認自己節點的列）
  "chat_history", // 往來記錄（要本人簽章；資料庫對網頁節點再過濾一次通知類）
  "read_sync", // 已讀位置同步（要本人簽章）
  "avatar", // 看同租戶設備的頭像（唯讀）
  "partner_avatar", // 看同租戶夥伴的頭像（唯讀）
  "web_sessions_list", // 這個帳號的網頁登入清單
  "web_logout_all", // 登出這個帳號所有網頁
]);

/** 網頁節點明確不能做的動作（其餘沒列的也一律拒絕；這份清單的用途是讓守門測試逼人對每個新動作表態） */
export const WEB_DENIED_ACTIONS: ReadonlySet<string> = new Set([
  // 發節點、發金鑰、換金鑰、邀請、裝置授權
  "register", "reissue", "invite", "node_create", "node_claim", "node_rotate_key", "cloud_node_create", "cloud_node_list", "cloud_node_revoke", "cloud_node_rename",
  "node_setup_request", "node_setup_status", "node_setup_code_fetch", "node_update_request", "node_update_status",
  "device_code_start", "device_code_poll", "device_code_approve", "device_key_publish", "device_key_alert", "device_rename", "leave",
  // 帳號層設定（之後依需要逐項開放）
  "account_bootstrap", "account_name", "account_settings", "account_device_prefs", "account_chat_pins",
  // 需要本人在手機確認的決定類，與會洩漏請求內容的清單
  "perm_req_create", "perm_req_take", "perm_req_result", "perm_req_list", "perm_req_decide",
  "term_req_create", "term_req_take", "term_req_result", "term_req_list", "term_req_decide",
  "secret_request", "secret_fetch", "secret_pending", "secret_reply",
  "group_confirm_decide", "group_confirm_list", "acct_login_alert",
  // 電腦端取件與回報、遠端開視窗與管理夥伴
  "launch", "launchers", "launch_pending", "launch_result",
  "partner_op", "partner_ops", "partner_archive", "partner_op_pending", "partner_op_result", "partner_op_progress", "partner_sync", "partner_list", "partner_succeed",
  "acct_report", "acct_list", "acct_switch", "acct_switch_pending", "acct_switch_result", "acct_switch_status", "acct_roster",
  "term_view_start", "term_view_report", "term_view_pending", "term_view_accept", "term_view_notice", "term_view_stop",
  "asn_setup_result", "asn_setup_code_put", "asn_update_result",
  // 分享、額度、用量、官網寫入、推播註冊
  "acct_share_create", "acct_share_revoke", "quota_read", "usage_report", "usage_list", "site_meeting_add", "site_release_upsert", "site_item_upsert", "push_register", "push_unregister",
  // 運維與通知回報（電腦端用節點金鑰打的）
  "roster", "bridge_notice", "misroute_notice", "waiting_notice", "node_mismatch_notice", "mux_blind_notice", "mux_down_notice", "outbox_bad_notice",
  "asn_presence", "set_name", "window_rename", "set_avatar", "set_partner_avatar", "tts", "tts_voices",
  // 寄信、附件、群組：第 2、3 階段再開放
  "send", "sent_status", "inbox_peek", "attach_init", "attach_commit", "attach_url", "attach_sweep",
  "group_ai_add", "group_ai_remove", "group_allow_others", "group_create", "group_invite_accept", "group_invite_create", "group_invite_preview", "group_invite_revoke", "group_leave", "group_upgrade",
  "room_list", "room_post", "room_read", "room_create", "room_add", "room_remove", "room_pin_set", "room_pin_get", "room_confirm_request", "room_confirm_status",
]);

/** 設定網頁版的網域。沒設＝空＝沒有任何網域被當成網頁來源、也沒有任何跨來源許可 */
export function webOrigins(env: (k: string) => string | undefined): string[] {
  const out: string[] = [];
  for (const raw of (env("ASN_WEB_ORIGINS") ?? "").split(",")) {
    const s = raw.trim();
    if (!s) continue;
    try {
      const u = new URL(s);
      if ((u.protocol === "https:" || (u.protocol === "http:" && u.hostname === "localhost")) && u.origin === s.replace(/\/+$/, "")) out.push(u.origin);
    } catch { /* 不合格的設定值直接略過 */ }
  }
  return out;
}

export const isWebOrigin = (origins: readonly string[], origin: string | null | undefined): boolean => !!origin && origins.includes(origin);

const CORS_ALLOW_HEADERS = "content-type, x-asn-user, x-asn-web, authorization, apikey, x-client-info";

/** 跨來源許可標頭：只給網頁版網域、回確切網址（不用 *、不反射別的來源）、不允許帶 cookie */
export function webCorsHeaders(origins: readonly string[], origin: string | null | undefined): Record<string, string> | null {
  if (!isWebOrigin(origins, origin)) return null;
  return {
    "access-control-allow-origin": origin as string,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": CORS_ALLOW_HEADERS,
    "access-control-max-age": "600",
    vary: "origin",
  };
}

/** 預檢請求：只認網頁版網域；其他來源回 null（由呼叫端照舊處理） */
export function webPreflight(origins: readonly string[], req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  const h = webCorsHeaders(origins, req.headers.get("origin"));
  return h ? new Response(null, { status: 204, headers: h }) : null;
}

/** 回應補上跨來源許可標頭（只對網頁版網域；其他來源原樣回） */
export function withWebCors(origins: readonly string[], req: Request, res: Response): Response {
  const h = webCorsHeaders(origins, req.headers.get("origin"));
  if (!h) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(h)) out.headers.set(k, v);
  return out;
}

const b64uDecode = (s: string): string => {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

/**
 * 從登入憑證取 session_id。簽章已由驗證服務驗過，這裡只解碼；格式不對、沒有、或 sub 對不上驗過的使用者都回 null。
 * 缺值不是錯誤：電腦與手機的舊憑證可能沒有，由呼叫端依來源決定要不要拒絕。
 */
export function sessionIdOfToken(token: string, expectedUser?: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const p = JSON.parse(b64uDecode(parts[1])) as Record<string, unknown>;
    if (typeof p.session_id !== "string" || !UUID.test(p.session_id)) return null;
    if (expectedUser !== undefined && p.sub !== expectedUser) return null;
    return p.session_id.toLowerCase();
  } catch {
    return null;
  }
}

/** 驗證結果只記幾秒：同一個請求裡的閘道與簽章驗證用同一次結果，不重複打驗證服務。只記成功的 */
export function memoVerify(
  verify: (token: string) => Promise<AuthUser | null>,
  ttlMs = 3000,
  now: () => number = Date.now,
): (token: string) => Promise<AuthUser | null> {
  const seen = new Map<string, { at: number; user: AuthUser }>();
  return async (token) => {
    const t = now();
    const hit = seen.get(token);
    if (hit && t - hit.at < ttlMs) return hit.user;
    const user = await verify(token);
    if (user) {
      if (seen.size > 500) for (const [k, v] of seen) if (t - v.at >= ttlMs) seen.delete(k);
      if (seen.size > 500) seen.clear();
      seen.set(token, { at: t, user });
    }
    return user;
  };
}

/** 瀏覽器摘要（只取名稱與系統，不存完整 User-Agent） */
export function browserLabel(ua: string | null | undefined): string {
  const s = typeof ua === "string" ? ua.slice(0, 400) : "";
  const browser = /Edg(e|A|iOS)?\//.test(s) ? "Edge" : /OPR\/|Opera/.test(s) ? "Opera" : /Firefox\/|FxiOS\//.test(s) ? "Firefox"
    : /Chrome\/|CriOS\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : "";
  const os = /iPhone|iPad|iPod/.test(s) ? "iOS" : /Android/.test(s) ? "Android" : /Windows/.test(s) ? "Windows" : /Mac OS X|Macintosh/.test(s) ? "macOS" : /Linux|X11/.test(s) ? "Linux" : "";
  if (!browser && !os) return "瀏覽器";
  return os ? `${browser || "瀏覽器"}（${os}）` : browser;
}

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;

export interface WebDeps {
  verifyJwt: (token: string) => Promise<AuthUser | null>;
  rpc: Rpc;
  sha256Hex: (s: string) => Promise<string>;
  origins: readonly string[];
}

export interface WebMe {
  id: string;
  bell_topic: string;
  role: string;
  tenant_id: string | null;
}

export interface WebNotice {
  notify: string;
  bell_topics: string[];
  mail_id: string | null;
}

export type WebGate =
  | { kind: "none" }
  | { kind: "reply"; status: number; body: Record<string, unknown> }
  | { kind: "web"; me: WebMe; user: AuthUser; sessionId: string; notice: WebNotice | null };

export interface WebRequestInfo {
  action: string | null;
  origin: string | null;
  hasKey: boolean;
  device: string | null;
  userHeader: string | null;
  userAgent: string | null;
}

/** 從請求取出閘道要看的欄位（標頭名稱集中在這裡） */
export function webRequestInfo(req: Request, action: string | null): WebRequestInfo {
  return {
    action, origin: req.headers.get("origin"), hasKey: !!req.headers.get("x-relay-key"), device: req.headers.get(WEB_HEADER),
    userHeader: req.headers.get(SIGN_HEADER), userAgent: req.headers.get("user-agent"),
  };
}

/** 非網頁路線的請求裡要檢查的登入憑證：登入憑證標頭（簽章），以及帳號動作／裝置授權動作的 Authorization */
export function webCredentialTokens(req: Request, action: string | null, usesAuthorization: (a: string) => boolean): string[] {
  const out: string[] = [];
  if (action && usesAuthorization(action)) {
    const a = bearerToken(req.headers.get("authorization"));
    if (a) out.push(a);
  }
  const u = bearerToken(req.headers.get(SIGN_HEADER));
  if (u) out.push(u);
  return out;
}

const reply = (status: number, error: string): WebGate => ({ kind: "reply", status, body: { error } });

const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** 網頁節點資料庫回的資料整理成固定形狀；缺欄位或型別不對一律回 null */
function parseMe(v: unknown): WebMe | null {
  const o = asRecord(v);
  if (!o || typeof o.id !== "string" || typeof o.bell_topic !== "string" || typeof o.role !== "string") return null;
  return { id: o.id, bell_topic: o.bell_topic, role: o.role, tenant_id: typeof o.tenant_id === "string" ? o.tenant_id : null };
}

function parseNotice(v: unknown): WebNotice | null {
  const o = asRecord(v);
  if (!o) return null;
  const topics = Array.isArray(o.bell_topics) ? o.bell_topics.filter((t): t is string => typeof t === "string" && t.length > 0) : [];
  return { notify: typeof o.notify === "string" ? o.notify : "failed", bell_topics: topics, mail_id: typeof o.mail_id === "string" ? o.mail_id : null };
}

/**
 * 判斷這個請求是不是走網頁路線，是的話一次做完：驗憑證、核對登入記錄、檢查放行清單。
 *   none  ＝不是網頁請求，呼叫端照舊處理
 *   reply ＝網頁請求但不能繼續（401、403、429…），直接把這個回出去
 *   web   ＝通過；me 是網頁節點，之後與一般節點同樣處理
 * 順序：先確認是誰（登出過的打任何動作都是 401），再看動作在不在放行清單（不在 403）。沒有登記過的瀏覽器打禁止的動作，不會因此被建立。
 */
export async function gateWebRequest(deps: WebDeps, r: WebRequestInfo): Promise<WebGate> {
  const fromWeb = isWebOrigin(deps.origins, r.origin);
  if (r.hasKey) return fromWeb ? reply(403, WEB_FORBIDDEN) : { kind: "none" }; // 網頁不持有節點金鑰；帶金鑰的網頁來源一律拒絕
  if (!fromWeb && !r.device) return { kind: "none" };
  // 沒設網頁版網域，或來源不是網頁版網域：網頁分支不啟用。帶瀏覽器代號一律 403，不驗憑證、不寫登入記錄、不建節點、不發通知
  if (!fromWeb) return reply(403, WEB_FORBIDDEN);
  if (!r.device || !WEB_DEVICE.test(r.device)) return reply(401, "unauthorized");
  const token = bearerToken(r.userHeader);
  if (!token) return reply(401, "unauthorized");
  let user: AuthUser | null = null;
  try {
    user = await deps.verifyJwt(token);
  } catch (e) {
    console.error("web verifyJwt", String(e));
  }
  if (!user) return reply(401, "unauthorized");
  // 網頁請求一定要有 session_id；沒有一律拒絕（不是網頁來源的缺值不在這裡處理）
  const sessionId = user.sessionId && UUID.test(user.sessionId) ? user.sessionId.toLowerCase() : null;
  if (!sessionId) return reply(401, "unauthorized");
  const allowed = r.action !== null && WEB_ALLOWED_ACTIONS.has(r.action);
  const { data, error } = await deps.rpc("asn_relay_web_touch", {
    p_user: user.id, p_session: sessionId, p_device_hash: await deps.sha256Hex("asn-web-device:" + r.device),
    p_label: browserLabel(r.userAgent), p_create: allowed,
  });
  if (error) { console.error("web_touch", error); return reply(500, "internal"); }
  const d = asRecord(data);
  if (!d) return reply(500, "internal");
  switch (d.error) {
    case undefined: break;
    case "signed_out": case "forbidden": case "bad_request": return reply(401, "unauthorized");
    case "unknown": return reply(403, WEB_FORBIDDEN);
    case "too_many": return reply(429, "too_many");
    case "tenant_inactive": return reply(403, "tenant_inactive");
    default: return reply(400, "bad_request");
  }
  const me = parseMe(d.node);
  if (!me) return reply(500, "internal");
  if (!allowed) return reply(403, WEB_FORBIDDEN);
  return { kind: "web", me, user, sessionId, notice: d.created === true && d.first === true ? parseNotice(d.notice) : null };
}

/**
 * 網頁登入的憑證只能走網頁路線：不是網頁路線的請求若帶著網頁登入的憑證（登入憑證標頭，或帳號動作的 Authorization），
 * 一律擋下。回 "web"＝是網頁的憑證（呼叫端回 403）、"error"＝查不出來（呼叫端回 500，寧可擋）。
 * 憑證沒有 session_id（電腦與手機的舊憑證）就不是網頁的憑證。
 */
export async function webCredentialCheck(
  deps: Pick<WebDeps, "verifyJwt" | "rpc">,
  tokens: readonly (string | null | undefined)[],
  cache: Map<string, number> = sessionKindCache,
  now: () => number = Date.now,
): Promise<"web" | "no" | "error"> {
  for (const token of tokens) {
    if (!token) continue;
    let user: AuthUser | null = null;
    try {
      user = await deps.verifyJwt(token);
    } catch (e) {
      console.error("web credential verify", String(e));
      return "error";
    }
    const sid = user?.sessionId && UUID.test(user.sessionId) ? user.sessionId.toLowerCase() : null;
    if (!sid) continue;
    // 記下「這個 session 是不是網頁」：是網頁的永久記住（不會變回一般）；不是的只記一分鐘，省得每個簽章請求都多查一次資料庫
    let until = cache.get(sid);
    if (until === undefined || until <= now()) {
      const { data, error } = await deps.rpc("asn_relay_web_session_is_web", { p_session: sid });
      if (error || typeof data !== "boolean") return "error";
      if (cache.size > 2000) cache.clear();
      until = data ? Infinity : now() + NOT_WEB_TTL_MS;
      cache.set(sid, until);
      if (data) return "web";
    } else if (until === Infinity) {
      return "web";
    }
  }
  return "no";
}
const NOT_WEB_TTL_MS = 60_000;
const sessionKindCache = new Map<string, number>();

/** 網頁專用的動作（登入清單、登出全部）。回 null 表示不是這兩個動作 */
export async function handleWebAction(
  deps: Pick<WebDeps, "rpc">,
  action: string,
  who: { user: AuthUser; sessionId: string },
): Promise<(Reply & { bellTopics: string[] }) | null> {
  if (action === "web_sessions_list") {
    const { data, error } = await deps.rpc("asn_relay_web_sessions_list", { p_user: who.user.id, p_session: who.sessionId });
    if (error) { console.error("web_sessions_list", error); return { status: 500, body: { error: "internal" }, bellTopics: [] }; }
    return { status: 200, body: { sessions: Array.isArray(data) ? data : [] }, bellTopics: [] };
  }
  if (action === "web_logout_all") {
    const { data, error } = await deps.rpc("asn_relay_web_logout_all", { p_user: who.user.id });
    const d = asRecord(data);
    if (error || !d || d.error) { console.error("web_logout_all", error ?? d?.error); return { status: 500, body: { error: "internal" }, bellTopics: [] }; }
    const topics = Array.isArray(d.bell_topics) ? d.bell_topics.filter((t): t is string => typeof t === "string" && t.length > 0) : [];
    return { status: 200, body: { ok: true, count: typeof d.count === "number" ? d.count : 0 }, bellTopics: topics };
  }
  return null;
}
