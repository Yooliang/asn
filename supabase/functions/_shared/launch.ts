// 遠端開 Claude 視窗（#64，規劃見 docs/relay/LAUNCHER.md）共用邏輯：irori-relay（節點金鑰）與 irori-api（擁有者登入）共用。
// 最後一道關在 supabase/sql/07_launch.sql 的函式（owner 限定、名稱、profile、cwd 白名單、重名、每小時上限）；
// 這裡負責：輸入整理與第一層格式檢查、節點動作的分派、錯誤碼對應。機器橋執行前還會再驗一次（relay/machine/launcher.mjs）。

// deno-lint-ignore no-explicit-any
type Json = any;

// 視窗名：英數、連字號、中文，1～40 字，不能以連字號開頭（不然會被 claude 當成命令列旗標）。跟 SQL、機器橋同一條規則
import { isReservedSender } from "./reserved_sender.ts";
import { isValidModelId } from "./model_id.ts";
export const LAUNCH_NAME_RE = /^[A-Za-z0-9一-鿿][A-Za-z0-9一-鿿-]{0,39}$/;
export const FIRST_MESSAGE_MAX = 4000;
export const NODE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LaunchDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: Json; error: unknown }>;
  ring: (topic: string) => Promise<void>;
};
export type Reply = { status: number; body: Json };

const ERROR_TEXT: Record<string, string> = {
  forbidden: "只有使用者本人能開新視窗",
  not_found: "找不到這台電腦（或這筆紀錄）",
  no_launcher: "這台電腦還沒設定 launcher.json（或機器橋沒在跑）",
  bad_name: "視窗名只能用英數、連字號、中文，1～40 字，不能以連字號開頭",
  bad_profile: "這台電腦沒有這個啟動設定",
  bad_cwd: "工作資料夾不在這台電腦允許的清單裡",
  bad_first_message: `第一句話最多 ${FIRST_MESSAGE_MAX} 字`,
  bad_pi_model: "經 pi 的提供者和模型要一起選，而且格式要對",
  bad_model: "型號格式不對（或不能和 pi 的提供者、模型一起指定）",
  model_unsupported: "那台電腦的 ASN 版本還不支援指定型號，請先更新",
  name_taken: "這台電腦已經有同名的視窗（或剛開過），換個名字",
  rate_limited: "這台電腦這個小時開太多視窗了，稍後再試",
  bad_request: "資料格式不對",
  internal: "伺服器發生錯誤",
};
export const launchErrorText = (code: string) => ERROR_TEXT[code] ?? "操作失敗";
const STATUS: Record<string, number> = { forbidden: 403, not_found: 404, no_launcher: 409, name_taken: 409, rate_limited: 429, internal: 500 };
export const fail = (code: string): Reply => ({ status: STATUS[code] ?? 400, body: { error: code, detail: launchErrorText(code) } });

export type LaunchRequest = { node: string; profile: string; name: string; cwd: string; first_message: string | null; pi_provider: string | null; pi_model: string | null; model: string | null };

// 第一層格式檢查（不查資料庫）；通過回整理好的請求，不通過回錯誤碼
export function parseLaunch(b: Json): LaunchRequest | { error: string } {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "bad_request" };
  const { node, profile, name, cwd } = b;
  if (typeof node !== "string" || !NODE_ID_RE.test(node)) return { error: "bad_request" };
  if (typeof profile !== "string" || profile.length < 1 || profile.length > 40) return { error: "bad_profile" };
  if (typeof name !== "string" || !LAUNCH_NAME_RE.test(name) || isReservedSender(name)) return { error: "bad_name" }; // 寄件名保留字檢查（見 reserved_sender.ts）
  if (typeof cwd !== "string" || cwd.length < 1 || cwd.length > 260) return { error: "bad_cwd" };
  let first: string | null = null;
  if (b.first_message != null) {
    if (typeof b.first_message !== "string") return { error: "bad_first_message" };
    first = b.first_message.trim() || null;
    if (first && first.length > FIRST_MESSAGE_MAX) return { error: "bad_first_message" };
  }
  // 指定型號（#2353）：選填，統一規則；與 pi 的提供者、模型不並存
  const model = b.model ?? null;
  if (model !== null && (!isValidModelId(model) || b.pi_provider != null || b.pi_model != null)) return { error: "bad_model" };
  // 經 pi 的提供者與模型（0.2 D2）：選填；兩個都給或都不給，各自走統一規則
  const pp = b.pi_provider ?? null, pm = b.pi_model ?? null;
  if ((pp === null) !== (pm === null)) return { error: "bad_pi_model" };
  if (pp !== null && (!isValidModelId(pp) || !isValidModelId(pm))) return { error: "bad_pi_model" };
  return { node, profile, name, cwd, first_message: first, pi_provider: pp, pi_model: pm, model };
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

// 下令開視窗（actor 是 owner 節點；不是的話 SQL 回 forbidden）。成功就敲那台機器的門鈴
// signedUser：本人簽章驗過的使用者 id（手機與用登入建立的電腦節點是 member 不是 owner，靠簽章證明「這個節點是這個人的」才准下令；
// 資料庫再核對一次擁有關係）。沒有簽章就不帶 p_signed_user，行為與以前完全相同（只有 role=owner 的節點准）
export async function requestLaunch(deps: LaunchDeps, actor: string, raw: Json, signedUser: string | null = null): Promise<Reply> {
  const req = parseLaunch(raw);
  if ("error" in req) return fail(req.error);
  // 帶了 model 才呼叫 10 參數版；只帶 pi 的提供者與模型呼叫 9 參數版（D2）；都沒帶照舊呼叫原本的，行為完全不變
  const withModel = req.model !== null;
  const withPi = req.pi_provider !== null;
  const r = await call(deps, "asn_relay_launch", {
    p_actor: actor, p_node: req.node, p_profile: req.profile, p_name: req.name, p_cwd: req.cwd, p_first: req.first_message,
    ...(withModel ? { p_signed_user: signedUser, p_pi_provider: null, p_pi_model: null, p_model: req.model }
      : withPi ? { p_signed_user: signedUser, p_pi_provider: req.pi_provider, p_pi_model: req.pi_model }
      : signedUser ? { p_signed_user: signedUser } : {}),
  });
  if (isReply(r)) return r;
  await deps.ring(r.data.bell_topic);
  return { status: 200, body: { id: r.data.id } };
}

// 各機器的啟動設定與最近紀錄（owner 限定）；ids 給了就只回那幾筆（查進度）
export async function listLaunchers(deps: LaunchDeps, actor: string, ids?: unknown, signedUser: string | null = null): Promise<Reply> {
  let p_ids: string[] | null = null;
  if (ids != null) {
    const list = Array.isArray(ids) ? ids : String(ids).split(",");
    if (list.length > 20 || !list.every((i) => typeof i === "string" && UUID_RE.test(i))) return fail("bad_request");
    p_ids = list as string[];
  }
  const r = await call(deps, "asn_relay_launchers", { p_actor: actor, p_ids, ...(signedUser ? { p_signed_user: signedUser } : {}) });
  if (isReply(r)) return r;
  return { status: 200, body: r.data };
}

// 機器橋回報的啟動設定摘要：只留 profile 的 id／label、cwd 白名單、每小時上限（指令內容一律不上傳）
// 啟動設定摘要裡「這台 pi 能用的模型」（#443／#444）：只留 { provider, model }，格式照 pi-models.mjs 的 SAFE，最多 200 筆；不合格的筆數丟掉，不整份拒收
export const PI_MODELS_MAX = 200;
export function sanitizePiModels(v: unknown): { provider: string; model: string }[] | null {
  if (!Array.isArray(v)) return null;
  const out: { provider: string; model: string }[] = [];
  for (const e of v) {
    if (out.length >= PI_MODELS_MAX) break;
    const provider = (e as Json)?.provider, model = (e as Json)?.model;
    if (typeof provider === "string" && typeof model === "string" && isValidModelId(provider) && isValidModelId(model)) out.push({ provider, model });
  }
  return out;
}

// 各家 CLI 的型號清單（#2353）：[{ vendor, status, stale?, code?, age_s?, models: [{ id, name }] }]。
// 每一層各自驗證，不假設上一層驗過：不合格的整家（或那一筆）丟掉，其餘照存，不整份拒收；不收原因的原文（reason）。
// SQL 端另有一份同規則的函式（relay.sanitize_launcher_models），兩邊由 tests 讀同一份向量守門。
export const MODELS_MAX_VENDORS = 8;
export const MODELS_MAX_PER_VENDOR = 200;
export const MODELS_MAX_BYTES = 24000; // 緊湊 JSON；SQL 最後一道 32000（jsonb::text 帶空格會大一些）
export const MODEL_NAME_MAX = 80;
const VENDOR_RE = /^[a-z][a-z0-9-]{0,19}$/;
const MODEL_STATUS = new Set(["ok", "unavailable", "error", "pending"]);
const MODEL_CODE = new Set(["ok", "not_installed", "not_logged_in", "timeout", "too_large", "parse_failed", "spawn_failed", "unsupported"]);
const AGE_S_MAX = 31536000;
// 控制字元、格式字元、孤立代理碼（JS 字串可能帶著；送進資料庫時 jsonb 會拒收）。SQL 端的 Cf 區間由 tools/gen-cf-ranges.mjs 產生
const UNSAFE_NAME_RE = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const isRec = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

function sanitizeVendor(e: unknown): Json | null {
  if (!isRec(e)) return null;
  const { vendor, status, stale, code, age_s, models } = e;
  if (typeof vendor !== "string" || !VENDOR_RE.test(vendor)) return null;
  if (typeof status !== "string" || !MODEL_STATUS.has(status)) return null;
  if (stale != null && typeof stale !== "boolean") return null;
  if (code != null && !(typeof code === "string" && MODEL_CODE.has(code))) return null;
  if (age_s != null && !(Number.isInteger(age_s) && (age_s as number) >= 0 && (age_s as number) <= AGE_S_MAX)) return null;
  if (models != null && !Array.isArray(models)) return null;
  const list: { id: string; name: string }[] = [];
  for (const m of (models ?? []) as unknown[]) {
    if (list.length >= MODELS_MAX_PER_VENDOR) break;
    if (!isRec(m) || !isValidModelId(m.id) || typeof m.name !== "string") continue;
    const n = [...m.name].length;
    if (n < 1 || n > MODEL_NAME_MAX || UNSAFE_NAME_RE.test(m.name)) continue;
    list.push({ id: m.id, name: m.name });
  }
  const o: Json = { vendor, status };
  if (stale != null) o.stale = stale;
  if (code != null) o.code = code;
  if (age_s != null) o.age_s = age_s;
  o.models = list;
  return o;
}

// 不是陣列回 null（不存）；是陣列就回整理後的陣列（可能是空的：代表「這台有回報，但沒有可用的」）
export function sanitizeModels(v: unknown): Json[] | null {
  if (!Array.isArray(v)) return null;
  const out: Json[] = [];
  const seen = new Set<string>();
  for (const e of v) {
    if (out.length >= MODELS_MAX_VENDORS) break;
    const o = sanitizeVendor(e);
    if (!o || seen.has(o.vendor)) continue; // 同一家重複：留先出現（且合格）的那筆
    seen.add(o.vendor);
    out.push(o);
  }
  return out;
}

// profile 的 engine（#2381）：Rust 實際送 claude／acp／pi，自訂 profile 可能是 codex，asn終端項目帶工具名 agy／grok；
// 所以用字元集而不是列舉，列舉會把將來新的引擎無聲丟掉
export const ENGINE_RE = /^[a-z0-9][a-z0-9._-]{0,29}$/;

const LAUNCH_MODES = new Set(["term", "background", "window"]);
export function sanitizeLauncher(l: Json): Json | null | { error: string } {
  if (l === null) return null;
  if (!l || typeof l !== "object" || Array.isArray(l) || !Array.isArray(l.profiles) || !Array.isArray(l.cwd_allow)) return { error: "bad_request" };
  // mode＝這個項目怎麼開（term＝asn終端、background＝背景、window＝視窗）：畫面靠它分辨 asn終端的虛擬項目；不認得的值不收
  const profiles = l.profiles.map((p: Json) => {
    const o: Json = { id: p?.id, label: typeof p?.label === "string" ? p.label.slice(0, 60) : null };
    if (typeof p?.engine === "string" && ENGINE_RE.test(p.engine)) o.engine = p.engine;
    if (typeof p?.mode === "string" && LAUNCH_MODES.has(p.mode)) o.mode = p.mode;
    return o;
  });
  const out: Json = { profiles, cwd_allow: l.cwd_allow };
  if (Number.isInteger(l.max_per_hour)) out.max_per_hour = l.max_per_hour;
  // 能力旗標：電腦端能依 launch 的 model 開窗才送 true；只收布林值，其他型別丟掉
  if (typeof l.launch_model === "boolean") out.launch_model = l.launch_model;
  const pi =sanitizePiModels(l.pi_models);
  if (pi && pi.length) out.pi_models = pi;
  const models = sanitizeModels(l.models);
  if (models) {
    const bytes = new TextEncoder().encode(JSON.stringify(models)).length;
    if (bytes > MODELS_MAX_BYTES) console.warn("launcher.models 超過上限，只丟 models，launcher 其餘照存", bytes, MODELS_MAX_BYTES);
    else out.models = models;
  }
  return out;
}

// 節點金鑰的動作（irori-relay）：
//   launch／launchers：只有 owner 節點（SQL 判斷）
//   launch_pending／launch_result：機器橋取走自己的待辦、回報結果（只動得到自己節點的）
export async function handleNodeLaunchAction(deps: LaunchDeps, me: { id: string }, action: string, params: Json, signedUser: string | null = null): Promise<Reply> {
  if (action === "launch") return await requestLaunch(deps, me.id, params, signedUser);
  if (action === "launchers") return await listLaunchers(deps, me.id, params?.ids, signedUser);
  if (action === "launch_pending") {
    const r = await call(deps, "asn_relay_launch_pending", { p_node: me.id });
    if (isReply(r)) return r;
    return { status: 200, body: { launches: r.data ?? [] } };
  }
  if (action === "launch_result") {
    const { id, status, detail, model_used } = params ?? {};
    if (typeof id !== "string" || !UUID_RE.test(id) || !["ok", "failed", "unconfirmed"].includes(status)) return fail("bad_request");
    // 實際採用的型號：格式合格才轉送（5 參數版）；舊電腦不送或不合格，照舊呼叫 4 參數版，結果照收
    const r = await call(deps, "asn_relay_launch_result", {
      p_node: me.id, p_id: id, p_status: status, p_detail: typeof detail === "string" ? detail.slice(0, 500) : null,
      ...(isValidModelId(model_used) ? { p_model_used: model_used } : {}),
    });
    if (isReply(r)) return r;
    return { status: 200, body: { ok: true } };
  }
  return { status: 404, body: { error: "not_found" } };
}
export const LAUNCH_ACTIONS = new Set(["launch", "launchers", "launch_pending", "launch_result"]);
