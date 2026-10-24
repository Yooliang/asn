// 遠端切換 Claude 帳號（ASN 帳號管理）共用邏輯。設計與流程見 supabase/migrations/20261021040000_asn_account_switch.sql。
// 最後一道關在資料庫函式（擁有者限定、同租戶、對方 ASN 在線、email 在對方回報的清單裡、頻率）；
// 這裡負責：輸入整理與第一層格式檢查、動作分派、錯誤碼對應。
// 權杖絕不經過這裡：回報與指令都只有廠商、email、方案、是否使用中；多餘欄位一律丟掉。

// deno-lint-ignore no-explicit-any
type Json = any;

export const NODE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 跟 ASN 的 normalize_email、資料庫的 asn_relay_acct_email_ok 同一條規則（小寫、一個 @、不含空白／控制字元／檔名禁用字元）
export const EMAIL_RE = /^[^@\s\p{Cc}/:*?"<>|\\]+@[^@\s\p{Cc}/:*?"<>|\\]+$/u;
export const MAX_ACCOUNTS = 20;
export const PLAN_MAX = 30;

export type AcctDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: Json; error: unknown }>;
  ring: (topic: string) => Promise<void>;
};
export type Reply = { status: number; body: Json };

const ERROR_TEXT: Record<string, string> = {
  forbidden: "只有使用者本人（擁有者設備）能遠端切換帳號",
  not_found: "找不到這台電腦（或這筆指令）",
  bad_request: "資料格式不對",
  bad_vendor: "目前只支援切換 Claude 帳號",
  bad_email: "email 格式不對",
  asn_offline: "對方電腦的 ASN 沒有在線，無法切換",
  unknown_account: "對方電腦的帳號庫裡沒有這個 email（請對方開著 ASN 讓清單更新）",
  busy: "對方電腦還有一個切換指令在處理中，請稍後再試",
  rate_limited: "這台電腦這個小時切換太多次了，稍後再試",
  internal: "伺服器發生錯誤",
};
export const acctErrorText = (code: string) => ERROR_TEXT[code] ?? "操作失敗";
const STATUS: Record<string, number> = { forbidden: 403, not_found: 404, asn_offline: 409, unknown_account: 409, busy: 409, rate_limited: 429, internal: 500 };
export const fail = (code: string): Reply => ({ status: STATUS[code] ?? 400, body: { error: code, detail: acctErrorText(code) } });

// email 整理：去頭尾空白、轉小寫；不合格回 null
export function cleanEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return e.length >= 3 && e.length <= 120 && EMAIL_RE.test(e) ? e : null;
}

export type ReportedAccount = { vendor: "claude" | "codex"; email: string; plan: string; current: boolean };
// 回報的清單：每筆只留 vendor／email／plan／current；任何一筆不合格整份退回（回 null）
export function parseReport(b: Json): ReportedAccount[] | null {
  if (!b || typeof b !== "object" || !Array.isArray(b.accounts) || b.accounts.length > MAX_ACCOUNTS) return null;
  const out: ReportedAccount[] = [];
  for (const a of b.accounts) {
    if (!a || typeof a !== "object" || (a.vendor !== "claude" && a.vendor !== "codex")) return null;
    const email = cleanEmail(a.email);
    if (!email) return null;
    let plan = "";
    if (a.plan != null) {
      if (typeof a.plan !== "string" || Array.from(a.plan).length > PLAN_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(a.plan)) return null;
      plan = a.plan.trim();
    }
    if (a.current != null && typeof a.current !== "boolean") return null;
    out.push({ vendor: a.vendor, email, plan, current: a.current === true });
  }
  return out;
}

export type SwitchRequest = { node: string; vendor: "claude"; email: string };
export function parseSwitch(b: Json): SwitchRequest | { error: string } {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "bad_request" };
  if (typeof b.node !== "string" || !NODE_ID_RE.test(b.node)) return { error: "bad_request" };
  if (b.vendor !== "claude") return { error: "bad_vendor" };
  const email = cleanEmail(b.email);
  if (!email) return { error: "bad_email" };
  return { node: b.node, vendor: "claude", email }; // 多餘欄位（command、token…）一律丟掉
}

async function call(deps: AcctDeps, fn: string, args: Record<string, unknown>): Promise<{ data: Json } | Reply> {
  const { data, error } = await deps.rpc(fn, args);
  if (error) {
    console.error(fn, error);
    return fail("internal");
  }
  if (data && typeof data === "object" && !Array.isArray(data) && typeof data.error === "string") return fail(data.error);
  return { data };
}
const isReply = (x: { data: Json } | Reply): x is Reply => "status" in x;

// 節點金鑰的動作（relay 函式）：
//   acct_report／acct_switch_pending／acct_switch_result：ASN 回報自己的清單、取走自己的待辦、回報結果（只動得到金鑰所屬的節點）
//   acct_list／acct_switch／acct_switch_status：擁有者節點（SQL 判斷 role = 'owner'）看別台清單、送指令、查結果
// signedUser：本人簽章驗過的使用者 id（只有 acct_list／acct_switch 會收；手機節點是 member，靠簽章證明「這個節點與租戶都是這個人的」才准）。
// 沒簽章就不帶 p_signed_user，行為與以前完全相同（只有 role = owner 的節點准）。
export async function handleAcctAction(deps: AcctDeps, me: { id: string }, action: string, params: Json, signedUser: string | null = null): Promise<Reply> {
  const signedArg = signedUser ? { p_signed_user: signedUser } : {};
  if (action === "acct_report") {
    const accounts = parseReport(params);
    if (!accounts) return fail("bad_request");
    const r = await call(deps, "asn_relay_acct_report", { p_node: me.id, p_accounts: accounts });
    return isReply(r) ? r : { status: 200, body: { ok: true, count: r.data?.count ?? accounts.length } };
  }
  if (action === "acct_list") {
    if (typeof params?.node !== "string" || !NODE_ID_RE.test(params.node)) return fail("bad_request");
    const r = await call(deps, "asn_relay_acct_list", { p_actor: me.id, p_node: params.node, ...signedArg });
    return isReply(r) ? r : { status: 200, body: r.data };
  }
  if (action === "acct_switch") {
    const req = parseSwitch(params);
    if ("error" in req) return fail(req.error);
    const r = await call(deps, "asn_relay_acct_switch", { p_actor: me.id, p_node: req.node, p_vendor: req.vendor, p_email: req.email, ...signedArg });
    if (isReply(r)) return r;
    await deps.ring(r.data.bell_topic);
    return { status: 200, body: { id: r.data.id } };
  }
  if (action === "acct_switch_pending") {
    const r = await call(deps, "asn_relay_acct_switch_pending", { p_node: me.id });
    return isReply(r) ? r : { status: 200, body: { requests: r.data?.requests ?? [] } };
  }
  if (action === "acct_switch_result") {
    const { id, status, detail } = params ?? {};
    if (typeof id !== "string" || !UUID_RE.test(id) || !["ok", "failed", "denied"].includes(status)) return fail("bad_request");
    const r = await call(deps, "asn_relay_acct_switch_result", {
      p_node: me.id, p_id: id, p_status: status, p_detail: typeof detail === "string" ? detail.slice(0, 300) : null,
    });
    return isReply(r) ? r : { status: 200, body: { ok: true } };
  }
  if (action === "acct_switch_status") {
    const ids = params?.ids;
    const list = Array.isArray(ids) ? ids : typeof ids === "string" ? ids.split(",") : null;
    if (!list || list.length < 1 || list.length > 20 || !list.every((i) => typeof i === "string" && UUID_RE.test(i))) return fail("bad_request");
    const r = await call(deps, "asn_relay_acct_switch_status", { p_actor: me.id, p_ids: list });
    return isReply(r) ? r : { status: 200, body: r.data };
  }
  return { status: 404, body: { error: "not_found" } };
}
export const ACCT_ACTIONS = new Set(["acct_report", "acct_list", "acct_switch", "acct_switch_pending", "acct_switch_result", "acct_switch_status"]);
