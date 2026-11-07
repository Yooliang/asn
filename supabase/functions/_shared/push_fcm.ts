// FCM HTTP v1 用戶端（#797 PR②）。只做兩件事：用服務帳戶私鑰換存取權杖（只要 firebase.messaging 範圍）、送一則固定文字的通知。
// 紅線（設計見私有文件，這裡只寫程式上的規則）：
//   * 通知的文字、tag、collapse_key 都是這支檔案裡的常數；函式不接受任何文字參數，所以信件內容、寄件人、群組名不可能進到 Google。
//   * `data` 欄位整個不送。
//   * 沒有設秘密（FCM_SERVICE_ACCOUNT）時 createFcm 回 null：呼叫端安靜不送。
//   * 存取權杖只放在這個 isolate 的記憶體；不寫資料庫、不寫 log。log 只記狀態碼，不記權杖、Google 的回應內文、私鑰。
export const PUSH_TITLE = "ASN";
export const PUSH_BODY = "ASN 有新訊息";
export const PUSH_TAG = "asn-new-message";
export const PUSH_CHANNEL = "asn_messages";
export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SKEW_S = 60;

/** 一次送出的結果：只有狀態碼和「權杖失效」判斷，沒有 Google 的回應內文 */
export type FcmResult = { status: number; invalid: boolean };
export type Fcm = { send: (deviceToken: string) => Promise<FcmResult> };
export type FcmEnv = { get: (k: string) => string | undefined };

/** 送給 FCM 的固定內容（測試鎖住：逐字等於這個，沒有 data） */
export function pushMessage(deviceToken: string) {
  return {
    message: {
      token: deviceToken,
      notification: { title: PUSH_TITLE, body: PUSH_BODY },
      android: { collapse_key: PUSH_TAG, priority: "HIGH", notification: { tag: PUSH_TAG, channel_id: PUSH_CHANNEL } },
    },
  };
}

const b64u = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
const text64 = (s: string) => b64u(new TextEncoder().encode(s));

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

type Account = { client_email: string; private_key: string; project_id: string };

function parseAccount(raw: string | undefined): Account | null {
  if (!raw) return null;
  try {
    const a = JSON.parse(raw);
    if (typeof a?.client_email === "string" && typeof a?.private_key === "string" && typeof a?.project_id === "string" && /^[a-z0-9-]{4,40}$/.test(a.project_id)) return a;
  } catch { /* 格式不對＝當作沒設，不記內容 */ }
  return null;
}

/** 讀秘密建立用戶端；沒設或格式不對回 null（呼叫端安靜不送） */
export function createFcm(env: FcmEnv, fetchFn: typeof fetch = fetch, nowMs: () => number = Date.now): Fcm | null {
  const acct = parseAccount(env.get("FCM_SERVICE_ACCOUNT"));
  if (!acct) return null;
  let key: CryptoKey | null = null;
  let cached: { token: string; exp: number } | null = null;

  async function signJwt(): Promise<string> {
    key ??= await crypto.subtle.importKey("pkcs8", pemToDer(acct!.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const iat = Math.floor(nowMs() / 1000);
    const head = text64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = text64(JSON.stringify({ iss: acct!.client_email, scope: FCM_SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claims}`));
    return `${head}.${claims}.${b64u(sig)}`;
  }

  async function accessToken(force = false): Promise<string | null> {
    if (!force && cached && cached.exp - SKEW_S > nowMs() / 1000) return cached.token;
    const r = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await signJwt() }),
    });
    if (!r.ok) {
      await r.body?.cancel();
      console.warn("push token_exchange failed", r.status);
      return null;
    }
    const j = await r.json().catch(() => null);
    if (typeof j?.access_token !== "string") return null;
    cached = { token: j.access_token, exp: nowMs() / 1000 + (Number(j.expires_in) || 3000) };
    return cached.token;
  }

  async function post(deviceToken: string, at: string): Promise<Response> {
    return await fetchFn(`https://fcm.googleapis.com/v1/projects/${acct!.project_id}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${at}`, "content-type": "application/json" },
      body: JSON.stringify(pushMessage(deviceToken)),
    });
  }

  return {
    async send(deviceToken) {
      try {
        let at = await accessToken();
        if (!at) return { status: 0, invalid: false };
        let r = await post(deviceToken, at);
        if (r.status === 401) {   // 存取權杖被撤銷或過期：換一把再試一次
          await r.body?.cancel();
          at = await accessToken(true);
          if (!at) return { status: 0, invalid: false };
          r = await post(deviceToken, at);
        }
        // 只看錯誤碼這一個欄位判斷權杖失效（必須是明確的 UNREGISTERED；沒有錯誤碼的 404 可能是專案代號設錯，不算權杖失效）；回應內文其他部分不記、不外傳
        let code = "";
        if (!r.ok) {
          const j = await r.json().catch(() => null);
          const d = Array.isArray(j?.error?.details) ? j.error.details.find((x: { errorCode?: string }) => typeof x?.errorCode === "string") : null;
          code = String(d?.errorCode ?? "");
        } else await r.body?.cancel();
        return { status: r.status, invalid: code === "UNREGISTERED" };
      } catch (_e) {
        console.warn("push send error");   // 例外訊息可能帶請求內容，不記
        return { status: 0, invalid: false };
      }
    },
  };
}
