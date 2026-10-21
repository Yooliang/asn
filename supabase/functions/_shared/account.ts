// 登入帳號的動作（人類動作）：account_bootstrap、node_create、node_claim。
// 身分一律來自 Supabase 登入憑證（Authorization: Bearer <access_token>）驗證後的使用者，body 裡不收使用者 id；
// node_claim 另外要 x-relay-key（現有節點金鑰）證明擁有；node_create 發新金鑰，只在這次回應裡出現一次，資料庫只存雜湊。
// 所有資料庫存取經 SECURITY DEFINER 函式（只授權 service_role）。見 docs/AUTH.md。
import { parseSelfName } from "./node_name.ts";

export const ACCOUNT_ACTIONS = new Set(["account_bootstrap", "node_create", "node_claim"]);

export interface AuthUser {
  id: string;
  email: string | null;
  name: string | null;
}

export interface AccountDeps {
  /** 驗證登入憑證；無效、過期、不是使用者（例如拿 anon／service key 來）一律回 null */
  verifyJwt: (token: string) => Promise<AuthUser | null>;
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  sha256Hex: (s: string) => Promise<string>;
  /** 產生新的節點金鑰與門鈴頻道（測試可換成固定值） */
  newSecrets: () => { key: string; bellTopic: string };
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** 取 Authorization 標頭的 Bearer 憑證；格式不對回 null */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,4096})$/.exec(header.trim());
  return m ? m[1] : null;
}

/** 顯示用的名字：去控制字元、限長；取不到就回 null */
export function cleanDisplayName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return s ? Array.from(s).slice(0, 40).join("") : null;
}

export interface NodeCreateInput {
  name: string;
  machine: string;
  device_id: string;
}

/** node_create 的輸入：電腦名稱（1～40 字）與 device_id（本機自產的亂數，16～64 字）。不合格回 null */
export function parseNodeCreate(b: unknown): NodeCreateInput | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const o = b as Record<string, unknown>;
  const name = parseSelfName(o.name);
  const machine = parseSelfName(o.machine ?? o.name);
  if (name === null || machine === null) return null;
  if (typeof o.device_id !== "string" || !DEVICE_ID.test(o.device_id)) return null;
  return { name, machine, device_id: o.device_id };
}

const ERR_STATUS: Record<string, number> = {
  invalid_key: 403,
  already_claimed: 409,
  tenant_not_yours: 409,
  tenant_inactive: 403,
  too_many: 429,
  bad_request: 400,
};

function mapError(code: string): Reply {
  return { status: ERR_STATUS[code] ?? 400, body: { error: code } };
}

/**
 * 處理三個帳號動作。authHeader＝Authorization 標頭；relayKey＝x-relay-key 標頭（只有 node_claim 用）；body＝JSON 內容（可為 null）。
 * 順序固定：先驗登入憑證，沒過就不碰資料庫。
 */
export async function handleAccountAction(
  deps: AccountDeps,
  action: string,
  authHeader: string | null,
  relayKey: string | null,
  body: unknown,
): Promise<Reply> {
  const token = bearerToken(authHeader);
  if (!token) return { status: 401, body: { error: "unauthorized" } };
  let user: AuthUser | null = null;
  try {
    user = await deps.verifyJwt(token);
  } catch (e) {
    console.error("verifyJwt", String(e));
    return { status: 500, body: { error: "internal" } };
  }
  if (!user || !UUID.test(user.id)) return { status: 401, body: { error: "unauthorized" } };

  if (action === "account_bootstrap") {
    const { data, error } = await deps.rpc("asn_account_bootstrap", { p_user: user.id, p_email: user.email, p_name: user.name });
    if (error) { console.error("account_bootstrap", error); return { status: 500, body: { error: "internal" } }; }
    return { status: 200, body: data as Record<string, unknown> };
  }

  if (action === "node_claim") {
    if (typeof relayKey !== "string" || relayKey.length < 8 || relayKey.length > 200) {
      return { status: 400, body: { error: "bad_request" } };
    }
    const { data, error } = await deps.rpc("asn_node_claim", { p_user: user.id, p_key_hash: await deps.sha256Hex(relayKey) });
    if (error) { console.error("node_claim", error); return { status: 500, body: { error: "internal" } }; }
    const d = data as Record<string, unknown>;
    if (typeof d?.error === "string") return mapError(d.error);
    return { status: 200, body: { ok: true, already: d?.already === true, node: d?.node } };
  }

  if (action === "node_create") {
    const input = parseNodeCreate(body);
    if (!input) return { status: 400, body: { error: "bad_request" } };
    const { key, bellTopic } = deps.newSecrets();
    // 金鑰本身不進資料庫：只送雜湊。回應裡的金鑰只這一次，之後沒有任何動作能再讀出它。
    const { data, error } = await deps.rpc("asn_node_create", {
      p_user: user.id, p_name: input.name, p_machine: input.machine, p_device_id: input.device_id,
      p_key_hash: await deps.sha256Hex(key), p_bell_topic: bellTopic,
    });
    if (error) { console.error("node_create", error); return { status: 500, body: { error: "internal" } }; }
    const d = data as Record<string, unknown>;
    if (typeof d?.error === "string") return mapError(d.error);
    return { status: 200, body: { id: d.id, key, bell_topic: d.bell_topic, rotated: d.rotated === true } };
  }

  return { status: 404, body: { error: "not_found" } };
}
