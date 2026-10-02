// 訊號指標：用 Firebase Realtime Database（RTDB，REST）當「有新東西」的指標，裝置監聽它、有變化才打 /updates，
// 不必每 25 秒長輪詢一次（Edge Function 呼叫數的大宗）。規格與上線步驟見 docs/relay/SIGNAL.md。
//
// 原則：
// - RTDB 只放指標（序號、時間、誰出聲），不放任何內容（話、信、聊天、記憶一律不進來）。
// - Supabase 先寫、RTDB 後寫；RTDB 寫失敗只記 log、不丟錯、不擋原本流程（前端另有保底輪詢）。
// - 兩個 secret 都沒設（IRORI_FIREBASE_DB_URL、IRORI_FIREBASE_SA）→ 整個功能關閉，行為跟沒有這支檔案一樣。
// - 前端零金鑰：讀取靠 RTDB Rules 公開讀「不可猜的路徑」，寫入只有這裡（服務帳戶身分，不受 Rules 限制）。
//
// irori-api 與 irori-relay 共用。純函式與可注入的 deps 讓測試不必打網路。

export const SCOPE = "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const POLL_S = 300; // 前端保底輪詢的間隔（秒），/updates 的 signal.poll_s 帶給前端（小良哥裁示 5 分鐘）。speaker 存活期與離開門檻都要大於它，見 speaker_live.ts、pointer.ts
export const TIMEOUT_MS = 3000; // 每次對 Google／RTDB 的呼叫最久等幾毫秒
export const JWT_TTL_S = 3600;
export const TOKEN_REUSE_MS = 55 * 60 * 1000; // access token 快取多久（Google 發的有效 1 小時，留 5 分鐘餘裕）
export const TOKEN_FAIL_BACKOFF_MS = 30 * 1000; // 換 token 失敗後這麼久內不再試，免得每次寫入都白等逾時

export type ServiceAccount = { client_email: string; private_key: string };
export type Config = { dbUrl: string; sa: ServiceAccount };
export type Deps = {
  config: () => Config | null; // null＝功能關閉
  fetch: typeof fetch;
  now: () => number; // epoch 毫秒
};

// ── 設定 ──

let warned = false;
const warnOnce = (msg: string) => {
  if (warned) return;
  warned = true;
  console.warn(msg);
};

// 兩個值都要有、格式都對才開；設了但格式不對一樣關閉（只記一次 log），不讓壞設定拖垮後端
export function parseConfig(dbUrl: string | undefined, saJson: string | undefined): Config | null {
  if (!dbUrl?.trim() || !saJson?.trim()) return null;
  const url = dbUrl.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^\s/]+$/.test(url)) {
    warnOnce("IRORI_FIREBASE_DB_URL 格式不對（要像 https://xxx.firebasedatabase.app），訊號功能關閉");
    return null;
  }
  try {
    const sa = JSON.parse(saJson);
    if (typeof sa?.client_email !== "string" || !sa.client_email || typeof sa?.private_key !== "string" || !sa.private_key.includes("PRIVATE KEY")) {
      warnOnce("IRORI_FIREBASE_SA 缺 client_email 或 private_key，訊號功能關閉");
      return null;
    }
    return { dbUrl: url, sa: { client_email: sa.client_email, private_key: sa.private_key } };
  } catch {
    warnOnce("IRORI_FIREBASE_SA 不是合法的 JSON，訊號功能關閉");
    return null;
  }
}

let memo: { key: string; cfg: Config | null } | null = null;
export function envConfig(): Config | null {
  const dbUrl = Deno.env.get("IRORI_FIREBASE_DB_URL") || undefined;
  const sa = Deno.env.get("IRORI_FIREBASE_SA") || undefined;
  if (!dbUrl || !sa) return null;
  const key = `${dbUrl}\n${sa}`;
  if (memo?.key !== key) memo = { key, cfg: parseConfig(dbUrl, sa) };
  return memo.cfg;
}

export const realDeps: Deps = { config: envConfig, fetch: (...a) => fetch(...a), now: () => Date.now() };
export const enabled = (deps: Pick<Deps, "config"> = realDeps): boolean => deps.config() !== null;

// ── 簽 JWT（RS256），換 access token ──

const enc = new TextEncoder();
const b64uBytes = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64uText = (s: string) => b64uBytes(enc.encode(s));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// PEM（服務帳戶 JSON 的 private_key，換行可能是真的換行，或被多跳脫成字面的 \n）→ DER
function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/\\n/g, "\n").replace(/-----(BEGIN|END)[^-]*-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

let keyMemo: { pem: string; key: Promise<CryptoKey> } | null = null;
function signingKey(pem: string): Promise<CryptoKey> {
  if (keyMemo?.pem !== pem) {
    keyMemo = {
      pem,
      key: crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]),
    };
    keyMemo.key.catch(() => { keyMemo = null; }); // 匯入失敗不留著（下次重試會再報同樣的錯）
  }
  return keyMemo.key;
}

export const jwtClaims = (sa: ServiceAccount, nowS: number) => ({
  iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowS, exp: nowS + JWT_TTL_S,
});

export async function signJwt(sa: ServiceAccount, nowS: number): Promise<string> {
  const head = b64uText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64uText(JSON.stringify(jwtClaims(sa, nowS)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await signingKey(sa.private_key), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64uBytes(new Uint8Array(sig))}`;
}

// 記錄用：access token 會出現在請求網址，Deno 的連線錯誤訊息又會帶出網址，所以一律遮掉再記
export const redact = (s: string) => s.replace(/access_token=[^&\s)"']+/g, "access_token=***");

let tokenCache: { token: string; exp: number; email: string } | null = null;
let tokenInflight: Promise<string | null> | null = null;
let tokenFailedUntil = 0;
export function resetForTest() {
  tokenCache = null;
  tokenInflight = null;
  tokenFailedUntil = 0;
  keyMemo = null;
  memo = null;
  warned = false;
}
const invalidateToken = () => { tokenCache = null; };

async function fetchToken(cfg: Config, deps: Pick<Deps, "fetch" | "now">): Promise<string | null> {
  const now = deps.now();
  try {
    const assertion = await signJwt(cfg.sa, Math.floor(now / 1000));
    const r = await deps.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 200)}`);
    const d = JSON.parse(text);
    if (typeof d?.access_token !== "string" || !d.access_token) throw new Error("回應沒有 access_token");
    const lifeMs = (Number(d.expires_in) > 0 ? Number(d.expires_in) : JWT_TTL_S) * 1000 - 5 * 60 * 1000;
    tokenCache = { token: d.access_token, exp: now + Math.min(TOKEN_REUSE_MS, Math.max(0, lifeMs)), email: cfg.sa.client_email };
    return d.access_token;
  } catch (e) {
    console.error("signal 換 token 失敗", redact(String(e)));
    tokenFailedUntil = now + TOKEN_FAIL_BACKOFF_MS;
    return null;
  }
}

// 取得 access token：快取約 55 分鐘；同時多個呼叫共用同一次換取；失敗回 null（並暫停重試一小段時間）
export async function accessToken(cfg: Config, deps: Pick<Deps, "fetch" | "now"> = realDeps): Promise<string | null> {
  const now = deps.now();
  if (tokenCache && tokenCache.email === cfg.sa.client_email && now < tokenCache.exp) return tokenCache.token;
  if (now < tokenFailedUntil) return null;
  tokenInflight ??= fetchToken(cfg, deps).finally(() => { tokenInflight = null; });
  return await tokenInflight;
}

// ── 寫入 ──

// PUT <db>/<path>.json。成功回 true；功能關閉、換不到 token、逾時、被拒、連不上一律回 false（只記 log，絕不丟錯）
export async function put(path: string, value: unknown, deps: Deps = realDeps): Promise<boolean> {
  try {
    const cfg = deps.config();
    if (!cfg) return false;
    const token = await accessToken(cfg, deps);
    if (!token) return false;
    const r = await deps.fetch(`${cfg.dbUrl}/${path.replace(/^\/+/, "")}.json?access_token=${encodeURIComponent(token)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) {
      if (r.status === 401) invalidateToken(); // token 被撤銷或過期：下次重換
      console.error("signal 寫入被拒", path.split("/")[0], r.status, (await r.text().catch(() => "")).slice(0, 200));
      return false;
    }
    await r.body?.cancel().catch(() => {});
    return true;
  } catch (e) {
    console.error("signal 寫入失敗", path.split("/")[0], redact(String(e)));
    return false;
  }
}

// ── 節點路徑（不可猜） ──

export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

// 每位使用者一個節點 p/<32 碼>：HMAC-SHA256(服務帳戶私鑰, "irori-signal-p:" + owner)。
// 沒有私鑰就算不出來（只用 owner 的雜湊，知道 uuid 的人就能算出路徑）。換了服務帳戶金鑰，路徑會跟著換；
// 前端每次 /updates 都會拿到最新的網址，會自己改接新的，舊節點只是不再更新
export async function ownerPath(owner: string, cfg: Config): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(cfg.sa.private_key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "p/" + hex(await crypto.subtle.sign("HMAC", key, enc.encode("irori-signal-p:" + owner))).slice(0, 32);
}

// 仲介來信門鈴的節點 b/<32 碼>：sha256("irori-bell:" + 門鈴頻道名) 前 32 碼。頻道名本身是 irori-relay 發的隨機字串（不可猜）。
// irori-relay 的 ring 與 irori-api 的 /updates 都用這支算，兩邊一定一致
export async function bellPath(topic: string): Promise<string> {
  return "b/" + (await sha256Hex("irori-bell:" + topic)).slice(0, 32);
}

export const urlOf = (cfg: Config, path: string) => `${cfg.dbUrl}/${path}.json`;

// irori-relay 每次敲門鈴時一併呼叫：寫 b/<hash> ＝ { at }（不帶任何內容）
export async function putBell(topic: string, deps: Deps = realDeps): Promise<boolean> {
  if (!deps.config()) return false;
  return await put(await bellPath(topic), { at: deps.now() }, deps);
}

// 在背景跑（Supabase Edge Function 的 waitUntil），不拖慢回應；沒有 waitUntil 就照樣在背景跑
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
export function background(p: Promise<unknown>): void {
  const safe = p.catch((e) => console.warn("signal 背景工作失敗", redact(String(e))));
  try {
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(safe);
  } catch { /* 沒有 waitUntil */ }
}
