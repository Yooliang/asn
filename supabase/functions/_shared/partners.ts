// 夥伴 ID（#109 第一期）：ASN 內建橋回報視窗名單時，順便送來「名字＋session」，後端判斷是哪位夥伴並回傳夥伴 ID。
// 動作 partner_sync：節點取自金鑰（me.id），body 不收節點。規則在資料庫函式 asn_relay_partner_sync：
//   同 session 改名＝同一位；同名換 session＝同一位（記交接）；名字與 session 都換＝新夥伴；同台兩個同名＝不處理。
// 這個檔案做：格式整理（先擋掉、少打一次資料庫）、錯誤對應、以及規則的純函式版（decidePartner，測試用來釘住規則，
// 與 SQL 逐項對照；SQL 本身另有 tests/partner_id_pglite.test.mjs 實跑）。
import type { AuthUser } from "./account.ts";
import { signedUserId } from "./owner_sign.ts";

export type RpcFn = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;

export const SESSION_RE = /^[A-Za-z0-9_-]{8,80}$/;
export const ENGINE_RE = /^[a-z][a-z0-9_-]{0,19}$/;
export const NAME_MAX = 60;
export const MODEL_MAX = 60;
export const WINDOWS_MAX = 100;
/** 舊名轉寄期（天），與資料庫 relay.partner_resolve 同 */
export const RENAME_FORWARD_DAYS = 7;

export interface PartnerWindow {
  name: string;
  session_id: string | null;
  engine: string | null;
  model: string | null;
}

/** 整理橋送來的名單；格式不對的名字整份拒絕（回 null），session／引擎／模型格式不對只當沒帶 */
export function parsePartnerSync(b: unknown): PartnerWindow[] | null {
  if (!b || typeof b !== "object") return null;
  const ws = (b as Record<string, unknown>).windows;
  if (!Array.isArray(ws) || ws.length > WINDOWS_MAX) return null;
  const out: PartnerWindow[] = [];
  for (const w of ws) {
    if (!w || typeof w !== "object") return null;
    const o = w as Record<string, unknown>;
    if (typeof o.name !== "string") return null;
    const len = Array.from(o.name).length;
    if (len < 1 || len > NAME_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(o.name)) return null;
    const model = typeof o.model === "string" ? o.model.trim().slice(0, MODEL_MAX) : "";
    out.push({
      name: o.name,
      session_id: typeof o.session_id === "string" && SESSION_RE.test(o.session_id) ? o.session_id : null,
      engine: typeof o.engine === "string" && ENGINE_RE.test(o.engine) ? o.engine : null,
      model: model === "" ? null : model,
    });
  }
  return out;
}

/** 資料庫還沒套用這支函式（PostgREST 找不到函式／Postgres 42883）：當作後端不支援，對外是 404（橋會靜默停用） */
function rpcMissing(e: unknown): boolean {
  const o = e as { code?: unknown; message?: unknown } | null;
  if (!o) return false;
  if (o.code === "PGRST202" || o.code === "42883") return true;
  return typeof o.message === "string" && /could not find the function/i.test(o.message);
}

export async function handlePartnerSync(
  deps: { rpc: RpcFn },
  me: { id: string },
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const windows = parsePartnerSync(body);
  if (windows === null) return { status: 400, body: { error: "bad_request" } };
  const { data, error } = await deps.rpc("asn_relay_partner_sync", { p_node: me.id, p_windows: windows });
  if (error) {
    if (rpcMissing(error)) return { status: 404, body: { error: "not_found" } };
    console.error(error);
    return { status: 500, body: { error: "internal" } };
  }
  const d = data as { error?: string; partners?: unknown } | null;
  if (d?.error === "not_found") return { status: 404, body: { error: "not_found" } };
  if (d?.error) return { status: 400, body: { error: d.error } };
  return { status: 200, body: { ok: true, partners: Array.isArray(d?.partners) ? d!.partners : [] } };
}

// ---- 第二期（#153）：指定接班、列出可被接班的夥伴。兩個動作都要本人簽章（x-asn-user）：節點金鑰 AI 視窗也拿得到，
// 但登入憑證只在 ASN 的 Rust 端，所以 AI 沒辦法替人把夥伴 ID 搬來搬去，也讀不到夥伴清單。
export const PARTNER_ID_RE = /^p_[0-9a-f]{20}$/;
const NODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

export interface SignedDeps {
  rpc: RpcFn;
  verifyJwt: (token: string) => Promise<AuthUser | null>;
}

/** 「這是某某的接班」請求：前任夥伴 ID、新視窗所在節點與名字；格式不對回 null */
export function parseSucceed(b: unknown): { predecessor: string; node: string; name: string } | null {
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  if (typeof o.predecessor !== "string" || !PARTNER_ID_RE.test(o.predecessor)) return null;
  if (typeof o.node !== "string" || !NODE_RE.test(o.node)) return null;
  if (typeof o.name !== "string") return null;
  const len = Array.from(o.name).length;
  if (len < 1 || len > NAME_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(o.name)) return null;
  return { predecessor: o.predecessor, node: o.node, name: o.name };
}

const SUCCEED_ERRORS: Record<string, number> = {
  bad_request: 400, forbidden: 403, not_found: 404, predecessor_live: 409,
};

export async function handlePartnerSucceed(
  deps: SignedDeps,
  me: { id: string },
  signHeader: string | null,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const q = parseSucceed(body);
  if (!q) return { status: 400, body: { error: "bad_request" } };
  const user = await signedUserId(deps.verifyJwt, signHeader);
  if (!user) return { status: 401, body: { error: "unauthorized" } };
  const { data, error } = await deps.rpc("asn_relay_partner_succeed", {
    p_user: user, p_caller: me.id, p_predecessor: q.predecessor, p_node: q.node, p_name: q.name,
  });
  if (error) {
    if (rpcMissing(error)) return { status: 404, body: { error: "not_found" } };
    console.error(error);
    return { status: 500, body: { error: "internal" } };
  }
  const d = data as { error?: string; ok?: boolean } | null;
  if (d?.error) return { status: SUCCEED_ERRORS[d.error] ?? 400, body: { error: d.error } };
  return { status: 200, body: { ok: true } };
}

export async function handlePartnerList(
  deps: SignedDeps,
  me: { id: string },
  signHeader: string | null,
): Promise<{ status: number; body: unknown }> {
  const user = await signedUserId(deps.verifyJwt, signHeader);
  if (!user) return { status: 401, body: { error: "unauthorized" } };
  const { data, error } = await deps.rpc("asn_relay_partner_list", { p_user: user, p_caller: me.id });
  if (error) {
    if (rpcMissing(error)) return { status: 404, body: { error: "not_found" } };
    console.error(error);
    return { status: 500, body: { error: "internal" } };
  }
  const d = data as { error?: string; partners?: unknown } | null;
  if (d?.error === "forbidden") return { status: 403, body: { error: "forbidden" } };
  if (d?.error) return { status: 400, body: { error: d.error } };
  return { status: 200, body: { partners: Array.isArray(d?.partners) ? d!.partners : [] } };
}

// ---- 規則的純函式版（與 SQL 逐項對照，供測試釘住；後端實際判斷在資料庫函式） ----

export interface PartnerRec {
  id: string;
  name: string | null;
  session: string | null;
  /** 歷任 session（含目前） */
  sessions: string[];
  oldNames: Array<{ name: string; at: number }>;
}

export type Decision =
  | { kind: "same" }
  | { kind: "rename"; id: string; from: string | null }
  | { kind: "handoff"; id: string; from: string | null }
  | { kind: "new" }
  | { kind: "blocked" };

/** 一個視窗（name、session）對上同一節點現有夥伴，依 #109 規則判斷；dupName＝同台同時有兩個同名 */
export function decidePartner(
  partners: PartnerRec[],
  w: { name: string; session: string | null },
  dupName = false,
): Decision {
  if (dupName) return { kind: "blocked" };
  const bySession = w.session ? partners.find((p) => p.sessions.includes(w.session!)) : undefined;
  if (bySession) {
    if (bySession.name !== w.name) return { kind: "rename", id: bySession.id, from: bySession.name };
    return bySession.session !== w.session ? { kind: "handoff", id: bySession.id, from: bySession.session } : { kind: "same" };
  }
  const byName = partners.find((p) => p.name === w.name);
  if (byName) {
    if (w.session && byName.session !== w.session) return { kind: "handoff", id: byName.id, from: byName.session };
    return { kind: "same" };
  }
  return { kind: "new" };
}

/** 寄信時名字 → 夥伴：目前的名字優先，其次轉寄期內的舊名（最近改的優先） */
export function resolvePartner(partners: PartnerRec[], name: string, now: number): string | null {
  const cur = partners.find((p) => p.name === name);
  if (cur) return cur.id;
  const win = RENAME_FORWARD_DAYS * 86_400_000;
  let best: { id: string; at: number } | null = null;
  for (const p of partners) {
    for (const o of p.oldNames) {
      if (o.name === name && now - o.at < win && (!best || o.at > best.at)) best = { id: p.id, at: o.at };
    }
  }
  return best?.id ?? null;
}
