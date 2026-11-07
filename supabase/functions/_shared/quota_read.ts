// 額度查詢（todo-next-193）。
//   quota_read：不用金鑰，憑代碼查單一帳號的額度；回應格式與舊的獨立查詢服務相同，讀取端只換網址和代碼。
//   acct_share_create／acct_share_revoke：本人替自己的帳號開或撤代碼，一定要本人簽章。
// 代碼只在開的當下回一次，資料庫只存雜湊；log 不記代碼、email。
import { cleanEmail, REPORT_VENDORS } from "./account_switch.ts";

// deno-lint-ignore no-explicit-any
type Json = any;
export type Reply = { status: number; body: Json };
export type QuotaDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: Json; error: unknown }>;
  sha256Hex: (s: string) => Promise<string>;
};

export const QUOTA_READ_ACTION = "quota_read";
export const QUOTA_SHARE_ACTIONS = new Set(["acct_share_create", "acct_share_revoke"]);
const CODE_RE = /^[0-9a-f]{64}$/;
// 同一帳號各窗的讀取時間差超過這個，舊的那窗就不回，不把過時的數字當成現在的
const WINDOW_STALE_MS = 30 * 60 * 1000;

// 窗名 → 讀取端認得的名稱。沒列的窗不回。
const LABELS: Record<string, Record<string, string>> = {
  claude: { five_hour: "工作階段", weekly: "本週 · 全模型" },
  codex: { five_hour: "5小時（已用）", weekly: "每週（已用）" },
  gemini: { five_hour: "Gemini Models 5小時", weekly: "Gemini Models 每週" },
  grok: { weekly: "每週 Super 限制（已用）" },
  minimax: { five_hour: "5小時（已用）", weekly: "週（已用）" },
};

export type QuotaRow = { vendor: string; plan?: string | null; windows?: unknown };

/** 資料庫的一列 → 回給讀取端的紀錄。left_pct 是剩餘，這裡轉成已用；重置時間已過的窗不回，缺的就是缺，不補 0。 */
export function quotaRecord(code: string, row: QuotaRow, now = Date.now()) {
  const windows: Json[] = Array.isArray(row.windows) ? row.windows : [];
  const reads = windows.map((w) => Date.parse(w?.read_at)).filter(Number.isFinite);
  const newest = reads.length ? Math.max(...reads) : null;
  const labels = LABELS[row.vendor] ?? {};
  const usage: Record<string, number> = {};
  const resets: Record<string, string> = {};
  for (const w of windows) {
    const label = labels[w?.name];
    const left = w?.left_pct;
    const read = Date.parse(w?.read_at);
    if (!label || typeof left !== "number" || left < 0 || left > 100 || !Number.isFinite(read)) continue;
    if (newest !== null && newest - read > WINDOW_STALE_MS) continue;
    const reset = typeof w.resets_at === "string" ? Date.parse(w.resets_at) : null;
    if (reset !== null && (!Number.isFinite(reset) || reset <= now)) continue;
    usage[label] = 100 - left;
    if (reset !== null) resets[label] = w.resets_at;
  }
  return {
    hash: code, vendor: row.vendor, plan: row.plan ?? "", usage, resets, expiry: "",
    reported_at: newest === null ? null : new Date(newest).toISOString(),
  };
}

export async function handleQuotaRead(deps: QuotaDeps, code: string, ip: string): Promise<Reply> {
  if (!CODE_RE.test(code)) return { status: 400, body: { error: "hash" } };
  const { data, error } = await deps.rpc("asn_relay_quota_read", {
    p_ip_hash: await deps.sha256Hex("ip:" + ip), p_code_hash: await deps.sha256Hex(code),
  });
  if (error) {
    console.error("asn_relay_quota_read failed");
    return { status: 500, body: { error: "read_failed" } };
  }
  if (data?.error === "rate_limited") return { status: 429, body: { error: "rate_limited" } };
  if (data?.error) return { status: 400, body: { error: "hash" } };
  return { status: 200, body: { record: data?.record ? quotaRecord(code, data.record) : null } };
}

export function newShareCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const SHARE_STATUS: Record<string, number> = { forbidden: 403, not_found: 404, bad_request: 400 };

export async function handleQuotaShare(
  deps: QuotaDeps, me: { id: string }, action: string, params: Json, signedUser: string | null, newCode = newShareCode,
): Promise<Reply> {
  if (!signedUser) return { status: 403, body: { error: "forbidden" } };
  const email = cleanEmail(params?.account);
  if (!email || !REPORT_VENDORS.has(params?.vendor)) return { status: 400, body: { error: "bad_request" } };
  const code = action === "acct_share_create" ? newCode() : null;
  const { data, error } = await deps.rpc("asn_relay_acct_share_set", {
    p_actor: me.id, p_signed_user: signedUser, p_vendor: params.vendor, p_account: email,
    p_code_hash: code === null ? null : await deps.sha256Hex(code),
  });
  if (error) {
    console.error("asn_relay_acct_share_set failed");
    return { status: 500, body: { error: "internal" } };
  }
  if (data?.error) return { status: SHARE_STATUS[data.error] ?? 400, body: { error: data.error } };
  return { status: 200, body: code === null ? { ok: true } : { ok: true, code } };
}
