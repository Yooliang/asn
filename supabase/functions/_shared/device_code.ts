// 裝置授權登入（給沒有畫面的主機）：主機 start 拿短碼與裝置碼 → 人在已登入的 ASN 輸入短碼 approve → 主機用裝置碼 poll 拿一次性的節點金鑰。
// 規矩：
//  - start、poll 不需要金鑰（主機還沒有）；approve 一定要登入憑證（Authorization: Bearer），沒過就不碰資料庫。
//  - 短碼、裝置碼、金鑰的明文都不進資料庫、不進 log：資料庫只收雜湊。金鑰是 poll 核准後第一次回應時當場產生，只在那次回應出現。
//  - 短碼 8 碼（去掉易混字元的 32 字母表）；核准時輸錯碼由資料庫按帳號限次（見 20261024120000_device_code.sql）。
// 資料庫函式與錯誤碼見該 migration。
import { type AuthUser, bearerToken, cleanDisplayName } from "./account.ts";

export const DEVICE_CODE_ACTIONS = new Set(["device_code_start", "device_code_approve", "device_code_poll"]);

export const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const USER_CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
export const EXPIRES_IN_SECONDS = 900;
export const POLL_INTERVAL_SECONDS = 5;
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DeviceCodeDeps {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  verifyJwt: (token: string) => Promise<AuthUser | null>;
  sha256Hex: (s: string) => Promise<string>;
  /** 產生新的短碼（顯示格式 ABCD-2345）與裝置碼（長亂數） */
  newCodes: () => { userCode: string; deviceCode: string };
  /** 產生新的節點金鑰與門鈴頻道 */
  newSecrets: () => { key: string; bellTopic: string };
}

export interface DeviceCodeReply {
  status: number;
  body: Record<string, unknown>;
}

/** 使用者輸入的短碼正規化：不分大小寫，容忍空白與連字號；不合格式回 null */
export function normalizeUserCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const raw = v.toUpperCase().replace(/[\s-]+/g, "");
  if (raw.length !== 8) return null;
  const c = raw.slice(0, 4) + "-" + raw.slice(4);
  return USER_CODE_RE.test(c) ? c : null;
}

/** 產生短碼：32 字母表、拒絕取樣避免偏差 */
export function randomUserCode(): string {
  const out: string[] = [];
  while (out.length < 8) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    for (const x of b) {
      if (x < 256 - (256 % USER_CODE_ALPHABET.length) && out.length < 8) out.push(USER_CODE_ALPHABET[x % USER_CODE_ALPHABET.length]);
    }
  }
  return out.slice(0, 4).join("") + "-" + out.slice(4).join("");
}

const ERR_STATUS: Record<string, number> = {
  invalid_code: 404,
  rate_limited: 429,
  id_taken: 409,
  bad_id_prefix: 403,
  too_many: 429,
  tenant_inactive: 403,
  bad_request: 400,
  slow_down: 429,
  invalid_device_code: 404,
};

const userHash = (deps: DeviceCodeDeps, code: string) => deps.sha256Hex("dc-user:" + code);
const deviceHash = (deps: DeviceCodeDeps, code: string) => deps.sha256Hex("dc-device:" + code);
const internal = (): DeviceCodeReply => ({ status: 500, body: { error: "internal" } });
const asObj = (b: unknown): Record<string, unknown> => (b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {});

export async function handleDeviceCodeAction(
  deps: DeviceCodeDeps,
  action: string,
  req: { ip: string; authHeader: string | null; body: unknown },
): Promise<DeviceCodeReply> {
  if (action === "device_code_start") {
    const ipHash = await deps.sha256Hex("ip:" + req.ip);
    for (let i = 0; i < 5; i++) {
      const { userCode, deviceCode } = deps.newCodes();
      const { data, error } = await deps.rpc("asn_device_code_start", {
        p_ip_hash: ipHash, p_device_hash: await deviceHash(deps, deviceCode), p_user_hash: await userHash(deps, userCode), p_interval: POLL_INTERVAL_SECONDS,
      });
      if (error) { console.error("device_code_start", error); return internal(); }
      const d = asObj(data);
      if (d.error === "collision") continue;
      if (typeof d.error === "string") return { status: ERR_STATUS[d.error] ?? 400, body: { error: d.error } };
      return {
        status: 200,
        body: { user_code: userCode, device_code: deviceCode, expires_in: EXPIRES_IN_SECONDS, interval: typeof d.interval === "number" ? d.interval : POLL_INTERVAL_SECONDS },
      };
    }
    return internal();
  }

  if (action === "device_code_approve") {
    // 身分一律來自登入憑證；沒過就不碰資料庫
    const token = bearerToken(req.authHeader);
    if (!token) return { status: 401, body: { error: "unauthorized" } };
    let user: AuthUser | null = null;
    try {
      user = await deps.verifyJwt(token);
    } catch (e) {
      console.error("verifyJwt", String(e));
      return internal();
    }
    if (!user || !UUID.test(user.id)) return { status: 401, body: { error: "unauthorized" } };
    const b = asObj(req.body);
    const code = normalizeUserCode(b.user_code);
    const name = cleanDisplayName(b.name);
    const nodeId = b.node_id === undefined || b.node_id === null || b.node_id === "" ? null : b.node_id;
    if (!code || name === null || (nodeId !== null && (typeof nodeId !== "string" || !NODE_ID_RE.test(nodeId)))) {
      return { status: 400, body: { error: "bad_request" } };
    }
    const { bellTopic } = deps.newSecrets();
    const { data, error } = await deps.rpc("asn_device_code_approve", {
      p_user: user.id, p_user_hash: await userHash(deps, code), p_node_id: nodeId, p_name: name, p_bell_topic: bellTopic,
    });
    if (error) { console.error("device_code_approve", error); return internal(); }
    const d = asObj(data);
    if (typeof d.error === "string") {
      return { status: ERR_STATUS[d.error] ?? 400, body: d.error === "bad_id_prefix" ? { error: d.error, prefix: d.prefix ?? null } : { error: d.error } };
    }
    return { status: 200, body: { ok: true, id: d.id, name: d.name } };
  }

  if (action === "device_code_poll") {
    const b = asObj(req.body);
    if (typeof b.device_code !== "string" || b.device_code.length < 8 || b.device_code.length > 200) return { status: 400, body: { error: "bad_request" } };
    // 金鑰在這裡當場產生；只有「核准後第一次輪詢」會被資料庫採用，其餘情形直接丟掉
    const { key } = deps.newSecrets();
    const { data, error } = await deps.rpc("asn_device_code_poll", {
      p_device_hash: await deviceHash(deps, b.device_code), p_key_hash: await deps.sha256Hex(key),
    });
    if (error) { console.error("device_code_poll", error); return internal(); }
    const d = asObj(data);
    if (typeof d.error === "string") return { status: ERR_STATUS[d.error] ?? 400, body: { error: d.error } };
    if (d.status === "approved") return { status: 200, body: { status: "approved", id: d.id, key, bell_topic: d.bell_topic } };
    if (d.status === "expired") return { status: 410, body: { error: "expired" } };
    return { status: 200, body: { status: "pending", interval: POLL_INTERVAL_SECONDS } };
  }

  return { status: 404, body: { error: "not_found" } };
}
