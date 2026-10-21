// 本人簽章（issue #118）：ASN 視窗送出的信，除了節點金鑰，另帶登入憑證（x-asn-user 標頭，值是 Bearer 憑證）。
// 憑證只存在 ASN 的 Rust 端，AI 用的 send.mjs、asn-cli 不帶。這裡只負責「憑證 → 使用者 id」：
//   - 沒帶、格式不對、驗證失敗、驗證時出錯：一律回 null（照舊當一般信，不擋寄送）；
//   - 驗證過：回使用者 id，由資料庫函式再核對「這個節點與租戶都是這個人的」才標 owner（見 migrations/20261021060000_owner_signed.sql）。
// 另用一個標頭而不用 Authorization，是因為 Authorization 要留給平台閘道的 anon 金鑰。
import { type AuthUser, bearerToken } from "./account.ts";

export const SIGN_HEADER = "x-asn-user";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function signedUserId(
  verifyJwt: (token: string) => Promise<AuthUser | null>,
  header: string | null | undefined,
): Promise<string | null> {
  const token = bearerToken(header);
  if (!token) return null;
  try {
    const u = await verifyJwt(token);
    return u && UUID.test(u.id) ? u.id : null;
  } catch (e) {
    console.error("owner_sign verifyJwt", String(e));
    return null;
  }
}

/** 有簽章才帶 p_signed_user；沒有就什麼都不加（還沒套 migration 的資料庫、舊簽章的函式也能照舊呼叫） */
export const signedArgs = (userId: string | null): Record<string, string> => (userId ? { p_signed_user: userId } : {});
