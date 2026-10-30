// 遠端切換 Claude 帳號（ASN 帳號管理）共用邏輯。設計與流程見 supabase/migrations/20261021040000_asn_account_switch.sql。
// 最後一道關在資料庫函式（擁有者限定、同租戶、對方 ASN 在線、email 在對方回報的清單裡、頻率）；
// 這裡負責：輸入整理與第一層格式檢查、動作分派、錯誤碼對應。
// 權杖絕不經過這裡：回報與指令都只有廠商、email、方案、是否使用中（Claude 另可選填剩餘額度四欄）；多餘欄位一律丟掉。

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
  bad_vendor: "目前只支援切換 Claude、Grok 帳號",
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

// 額度窗（#374 帳號列表）：name＝five_hour／weekly／w<分鐘數>；left_pct＝剩餘 0～100 整數；resets_at＝重置時間（可空）；read_at＝那台電腦讀到的時間
export type QuotaWindow = { name: string; left_pct: number; resets_at: string | null; read_at: string };
export type ReportedAccount = { vendor: "claude" | "codex" | "grok" | "gemini"; email: string; plan: string; current: boolean; five_hour_pct?: number; weekly_pct?: number; reset_at?: string; five_reset_at?: string; week_reset_at?: string; at?: string; windows?: QuotaWindow[] };

// 剩餘額度（#228，全部選填）：five_hour_pct／weekly_pct 是 0～100 的剩餘百分比，reset_at 是重置時間，at 是那台電腦記下數字的時間。
// five_reset_at／week_reset_at（#374，選填）：兩條各自的重置時間（reset_at 是舊的、兩條共用一個，照收）。
// 只收 Claude。不合格的欄位單獨丟掉（不退回整份，免得額度壞掉拖累帳號清單）；沒有合格的百分比或沒有合格的 at 就整組不收。
const FUTURE_SLACK_MS = 10 * 60 * 1000;
function isoOrNull(v: unknown, maxFutureMs: number | null): string | null {
  if (typeof v !== "string" || v.length > 40) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  if (maxFutureMs != null && t > Date.now() + maxFutureMs) return null;
  return new Date(t).toISOString();
}
const pctOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : null);
export function parseQuota(a: Json): Pick<ReportedAccount, "five_hour_pct" | "weekly_pct" | "reset_at" | "five_reset_at" | "week_reset_at" | "at"> {
  const five = pctOrNull(a.five_hour_pct), week = pctOrNull(a.weekly_pct);
  const at = isoOrNull(a.at, FUTURE_SLACK_MS);
  if ((five == null && week == null) || at == null) return {};
  const reset = isoOrNull(a.reset_at, null);
  // 兩條各自的重置時間（#374）：只在那條的百分比也收了時才留
  const fiveReset = five != null ? isoOrNull(a.five_reset_at, null) : null;
  const weekReset = week != null ? isoOrNull(a.week_reset_at, null) : null;
  return {
    ...(five != null ? { five_hour_pct: five } : {}), ...(week != null ? { weekly_pct: week } : {}), ...(reset != null ? { reset_at: reset } : {}),
    ...(fiveReset != null ? { five_reset_at: fiveReset } : {}), ...(weekReset != null ? { week_reset_at: weekReset } : {}), at,
  };
}
// 新版的額度窗（#374）：只收 claude、codex、gemini（grok 一律不收；gemini 只收 five_hour、weekly，#1515）。壞掉的單窗丟掉，不退回整份；同名只留第一個；最多 4 個。
// 規則跟資料庫的 asn_relay_acct_windows_clean 相同（那邊會再檢查一次，並把 Codex 的 w300／w10080 轉成 five_hour／weekly）。
export const MAX_WINDOWS = 4;
const WINDOW_NAME_RE = /^(five_hour|weekly|w[0-9]{1,6})$/;
// 重置時間的合理範圍（#524 審查）：「現在 −1 天」到「現在 +8 天」，超出就丟那一窗（不然一個 2099 年的值會把那一窗永遠鎖住）
export const RESET_PAST_MS = 24 * 60 * 60 * 1000;
export const RESET_FUTURE_MS = 8 * 24 * 60 * 60 * 1000;
export function resetInRange(iso: string, now = Date.now()): boolean {
  const t = Date.parse(iso);
  return t >= now - RESET_PAST_MS && t <= now + RESET_FUTURE_MS;
}
const GEMINI_WINDOWS = new Set(["five_hour", "weekly"]);
export function parseWindows(v: unknown, now = Date.now()): QuotaWindow[] {
  if (!Array.isArray(v)) return [];
  const out: QuotaWindow[] = [];
  for (const w of v.slice(0, 16)) {
    if (out.length >= MAX_WINDOWS) break;
    if (!w || typeof w !== "object" || typeof w.name !== "string" || !WINDOW_NAME_RE.test(w.name)) continue;
    const left = pctOrNull(w.left_pct);
    const read = isoOrNull(w.read_at, FUTURE_SLACK_MS);
    if (left == null || read == null) continue;
    let reset: string | null = null;
    if (w.resets_at != null) {
      reset = isoOrNull(w.resets_at, null);
      if (reset == null || !resetInRange(reset, now)) continue;
    }
    if (out.some((o) => o.name === w.name)) continue;
    out.push({ name: w.name, left_pct: left, resets_at: reset, read_at: read });
  }
  return out;
}
// 回報的清單：每筆只留 vendor／email／plan／current（claude 另可帶額度四欄；claude、codex、gemini 另可帶 windows）；任何一筆不合格整份退回（回 null）
const VENDORS = new Set(["claude", "codex", "grok", "gemini"]);
// 舊的 asn_relay_acct_report／relay.asn_accounts 不收 gemini（有一筆就整份退回），呼叫前要先拿掉（#1515）
export const LEGACY_VENDORS = new Set(["claude", "codex", "grok"]);
export function parseReport(b: Json): ReportedAccount[] | null {
  if (!b || typeof b !== "object" || !Array.isArray(b.accounts) || b.accounts.length > MAX_ACCOUNTS) return null;
  const out: ReportedAccount[] = [];
  for (const a of b.accounts) {
    if (!a || typeof a !== "object" || !VENDORS.has(a.vendor)) return null;
    const email = cleanEmail(a.email);
    if (!email) return null;
    let plan = "";
    if (a.plan != null) {
      if (typeof a.plan !== "string" || Array.from(a.plan).length > PLAN_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(a.plan)) return null;
      plan = a.plan.trim();
    }
    if (a.current != null && typeof a.current !== "boolean") return null;
    // 清完一窗都不剩就不帶 windows，讓資料庫退回舊四欄（#524 審查）
    const parsed = a.vendor !== "grok" && Array.isArray(a.windows) ? parseWindows(a.windows) : [];
    const cleaned = a.vendor === "gemini" ? parsed.filter((w) => GEMINI_WINDOWS.has(w.name)) : parsed;
    const windows = cleaned.length ? { windows: cleaned } : {};
    out.push({ vendor: a.vendor, email, plan, current: a.current === true, ...(a.vendor === "claude" ? parseQuota(a) : {}), ...windows });
  }
  return out;
}

export type SwitchRequest = { node: string; vendor: "claude" | "grok"; email: string };
export function parseSwitch(b: Json): SwitchRequest | { error: string } {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "bad_request" };
  if (typeof b.node !== "string" || !NODE_ID_RE.test(b.node)) return { error: "bad_request" };
  if (b.vendor !== "claude" && b.vendor !== "grok") return { error: "bad_vendor" };
  const email = cleanEmail(b.email);
  if (!email) return { error: "bad_email" };
  return { node: b.node, vendor: b.vendor, email }; // 多餘欄位（command、token…）一律丟掉
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

// 帳號列表（#374）：舊回報寫完後再寫一份到 relay.asn_user_accounts。失敗只記 log（不含 email），不影響 acct_report 的回覆。
async function rosterReport(deps: AcctDeps, node: string, accounts: ReportedAccount[]): Promise<void> {
  try {
    const { data, error } = await deps.rpc("asn_relay_acct_roster_report", { p_node: node, p_accounts: accounts });
    if (error) {
      console.warn("asn_relay_acct_roster_report failed", node, error);
      return;
    }
    if (data && typeof data === "object" && typeof data.error === "string") {
      if (data.error !== "not_claimed") console.warn("asn_relay_acct_roster_report", node, data.error);
      return;
    }
    const skipped: Json[] = Array.isArray(data?.skipped) ? data.skipped : [];
    if (skipped.length) {
      console.info("asn_relay_acct_roster_report skipped", node, skipped.map((x) => `${x?.vendor}/${x?.window}:${x?.reason}`).join(","));
    }
  } catch (e) {
    console.warn("asn_relay_acct_roster_report threw", node, e instanceof Error ? e.message : String(e));
  }
}

// 節點金鑰的動作（relay 函式）：
//   acct_report／acct_switch_pending／acct_switch_result：ASN 回報自己的清單、取走自己的待辦、回報結果（只動得到金鑰所屬的節點）
//   acct_list／acct_switch／acct_switch_status：擁有者節點（SQL 判斷 role = 'owner'）看別台清單、送指令、查結果
//   acct_roster：本人的帳號列表（#374），一定要本人簽章，只回自己的；沒簽章不呼叫資料庫
// signedUser：本人簽章驗過的使用者 id（只有 acct_list／acct_switch 會收；手機節點是 member，靠簽章證明「這個節點與租戶都是這個人的」才准）。
// 沒簽章就不帶 p_signed_user，行為與以前完全相同（只有 role = owner 的節點准）。
export async function handleAcctAction(deps: AcctDeps, me: { id: string }, action: string, params: Json, signedUser: string | null = null): Promise<Reply> {
  const signedArg = signedUser ? { p_signed_user: signedUser } : {};
  if (action === "acct_report") {
    const accounts = parseReport(params);
    if (!accounts) return fail("bad_request");
    // 舊的 asn_relay_acct_report 照舊（不帶 windows、拿掉 gemini，交給它的內容跟以前一模一樣）；gemini 只寫帳號列表
    const legacy = accounts.filter((a) => LEGACY_VENDORS.has(a.vendor)).map(({ windows: _w, ...rest }) => rest);
    const r = await call(deps, "asn_relay_acct_report", { p_node: me.id, p_accounts: legacy });
    if (isReply(r)) return r;
    await rosterReport(deps, me.id, accounts);
    return { status: 200, body: { ok: true, count: r.data?.count ?? accounts.length } };
  }
  if (action === "acct_roster") {
    // 帳號列表只給本人：沒簽章直接 forbidden，不呼叫資料庫
    if (!signedUser) return fail("forbidden");
    const r = await call(deps, "asn_relay_acct_roster", { p_actor: me.id, p_signed_user: signedUser });
    return isReply(r) ? r : { status: 200, body: r.data };
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
export const ACCT_ACTIONS = new Set(["acct_report", "acct_list", "acct_switch", "acct_switch_pending", "acct_switch_result", "acct_switch_status", "acct_roster"]);
