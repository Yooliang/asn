// 訊號指標（_shared/signal.ts）的守門測試：JWT 組裝、token 快取、路徑雜湊、沒設 secrets 就完全不寫、寫入失敗不丟錯。
// 全部用假金鑰與假 fetch，不打網路。跑法：SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno test -A signal_test.ts
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  accessToken, bellPath, type Config, type Deps, enabled, envConfig, jwtClaims, ownerPath, parseConfig, POLL_S, put, putBell, redact,
  resetForTest, SCOPE, sha256Hex, signJwt, TOKEN_FAIL_BACKOFF_MS, TOKEN_REUSE_MS, TOKEN_URL, urlOf,
} from "./signal.ts";

// ── 測試用的假服務帳戶（每次測試現產一組 RSA 金鑰，絕不用真的） ──
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
async function makeKeys() {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64(der).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return { pem, pub: kp.publicKey };
}
const keys = await makeKeys();
const EMAIL = "irori-writer@irori-xisu.iam.gserviceaccount.com";
const SA = { client_email: EMAIL, private_key: keys.pem };
const DB = "https://irori-xisu-default-rtdb.asia-southeast1.firebasedatabase.app";
const CFG: Config = { dbUrl: DB, sa: SA };
const SA_JSON = JSON.stringify({ type: "service_account", project_id: "irori-xisu", ...SA });

const T0 = Date.parse("2026-10-03T00:00:00Z");
const decode = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

// 假的 Google／RTDB：依網址回應，記下每次呼叫
function fakeNet(opts: { tokenStatus?: number; putStatus?: number; expiresIn?: number; putThrows?: boolean } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let n = 0;
  const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u === TOKEN_URL) {
      n++;
      if ((opts.tokenStatus ?? 200) !== 200) return Promise.resolve(new Response("denied", { status: opts.tokenStatus }));
      return Promise.resolve(new Response(JSON.stringify({ access_token: `tok-${n}`, expires_in: opts.expiresIn ?? 3600, token_type: "Bearer" }), { status: 200 }));
    }
    if (opts.putThrows) return Promise.reject(new TypeError(`error sending request for url (${u})`));
    return Promise.resolve(new Response(opts.putStatus && opts.putStatus !== 200 ? '{"error":"Permission denied"}' : "{}", { status: opts.putStatus ?? 200 }));
  }) as typeof fetch;
  const clock = { t: T0 };
  const deps: Deps = { config: () => CFG, fetch: fetchFn, now: () => clock.t };
  return { deps, calls, clock, tokenCalls: () => calls.filter((c) => c.url === TOKEN_URL).length };
}

// 抓 console.error／warn，避免測試輸出一堆預期中的錯誤，也能檢查有沒有洩漏 token
async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const e = console.error, w = console.warn;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    return { result: await fn(), logs: lines.join("\n") };
  } finally {
    console.error = e;
    console.warn = w;
  }
}

// ── 設定：兩個 secret 都有才開 ──

Deno.test("設定：兩個都設且格式對才開；少一個、空白、壞掉都是關閉", async () => {
  resetForTest();
  assertEquals(parseConfig(DB, SA_JSON)?.dbUrl, DB);
  assertEquals(parseConfig(DB + "/", SA_JSON)?.dbUrl, DB, "尾巴的斜線拿掉");
  assertEquals(parseConfig(`  ${DB}  `, SA_JSON)?.sa.client_email, EMAIL);
  assertEquals(parseConfig(undefined, SA_JSON), null);
  assertEquals(parseConfig(DB, undefined), null);
  assertEquals(parseConfig("", SA_JSON), null);
  assertEquals(parseConfig(DB, "  "), null);
  await quiet(() => {
    assertEquals(parseConfig("http://insecure.example.com", SA_JSON), null, "只收 https");
    assertEquals(parseConfig("https://x.firebasedatabase.app/p/oops", SA_JSON), null, "網址不能帶路徑");
    assertEquals(parseConfig(DB, "not json"), null);
    assertEquals(parseConfig(DB, JSON.stringify({ client_email: EMAIL })), null, "沒有私鑰");
    assertEquals(parseConfig(DB, JSON.stringify({ client_email: EMAIL, private_key: "abc" })), null, "私鑰不像私鑰");
    assertEquals(parseConfig(DB, JSON.stringify({ private_key: keys.pem })), null, "沒有 client_email");
    return Promise.resolve();
  });
});

Deno.test("設定：讀環境變數，兩個都沒設／只設一個＝關閉，兩個都設＝開", () => {
  resetForTest();
  const URL_KEY = "IRORI_FIREBASE_DB_URL", SA_KEY = "IRORI_FIREBASE_SA";
  const keep = [Deno.env.get(URL_KEY), Deno.env.get(SA_KEY)];
  try {
    Deno.env.delete(URL_KEY);
    Deno.env.delete(SA_KEY);
    assertEquals(envConfig(), null);
    assertEquals(enabled(), false, "兩個都沒設：關閉");
    Deno.env.set(URL_KEY, DB);
    assertEquals(enabled(), false, "只設網址：關閉");
    Deno.env.delete(URL_KEY);
    Deno.env.set(SA_KEY, SA_JSON);
    assertEquals(enabled(), false, "只設服務帳戶：關閉");
    Deno.env.set(URL_KEY, DB);
    assertEquals(enabled(), true, "兩個都設：開");
    assertEquals(envConfig()?.dbUrl, DB);
  } finally {
    for (const [k, v] of [[URL_KEY, keep[0]], [SA_KEY, keep[1]]] as const) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    resetForTest();
  }
});

// ── JWT ──

Deno.test("JWT：header、claims 正確，簽章用對應公鑰驗得過", async () => {
  const nowS = Math.floor(T0 / 1000);
  const jwt = await signJwt(SA, nowS);
  const [h, c, s] = jwt.split(".");
  assertEquals(JSON.parse(decode(h)), { alg: "RS256", typ: "JWT" });
  assertEquals(JSON.parse(decode(c)), {
    iss: EMAIL,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowS,
    exp: nowS + 3600,
  });
  assertEquals(SCOPE, JSON.parse(decode(c)).scope);
  const sig = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
  assert(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keys.pub, sig, new TextEncoder().encode(`${h}.${c}`)), "簽章要驗得過");
  assert(!/[+/=]/.test(jwt.replace(/\./g, "")), "base64url：沒有 + / =");
  assertEquals(jwtClaims(SA, 5).exp, 5 + 3600);
});

Deno.test("JWT：竄改內容簽章就驗不過；私鑰換行被多跳脫成字面 \\n 也簽得出來", async () => {
  const [h, c, s] = (await signJwt(SA, 1000)).split(".");
  const sig = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
  assertEquals(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keys.pub, sig, new TextEncoder().encode(`${h}.${c}x`)), false);
  const escaped = { ...SA, private_key: keys.pem.replace(/\n/g, "\\n") };
  const jwt2 = await signJwt(escaped, 1000);
  assertEquals(jwt2, await signJwt(SA, 1000), "RS256（PKCS1 v1.5）簽章是確定性的：同樣內容簽出同樣結果");
});

// ── access token ──

Deno.test("token：POST 到 Google，帶 jwt-bearer 與簽好的 assertion；回來的 token 拿去用", async () => {
  resetForTest();
  const net = fakeNet();
  assertEquals(await accessToken(CFG, net.deps), "tok-1");
  const call = net.calls[0];
  assertEquals(call.url, "https://oauth2.googleapis.com/token");
  assertEquals(call.init?.method, "POST");
  assertEquals((call.init?.headers as Record<string, string>)["content-type"], "application/x-www-form-urlencoded");
  const body = call.init?.body as URLSearchParams;
  assertEquals(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const claims = JSON.parse(decode(body.get("assertion")!.split(".")[1]));
  assertEquals(claims.iss, EMAIL);
  assertEquals(claims.iat, Math.floor(T0 / 1000));
  assert(call.init?.signal, "要有逾時（3 秒）");
});

Deno.test("token：約 55 分鐘內重用，不再打 Google；過期才重換", async () => {
  resetForTest();
  const net = fakeNet();
  assertEquals(await accessToken(CFG, net.deps), "tok-1");
  net.clock.t = T0 + 30 * 60 * 1000;
  assertEquals(await accessToken(CFG, net.deps), "tok-1");
  net.clock.t = T0 + TOKEN_REUSE_MS - 1;
  assertEquals(await accessToken(CFG, net.deps), "tok-1");
  assertEquals(net.tokenCalls(), 1);
  net.clock.t = T0 + TOKEN_REUSE_MS;
  assertEquals(await accessToken(CFG, net.deps), "tok-2");
  assertEquals(net.tokenCalls(), 2);
  assertEquals(TOKEN_REUSE_MS, 55 * 60 * 1000);
});

Deno.test("token：Google 說的有效期比 1 小時短，就依它的（扣掉 5 分鐘餘裕）", async () => {
  resetForTest();
  const net = fakeNet({ expiresIn: 600 });
  assertEquals(await accessToken(CFG, net.deps), "tok-1");
  net.clock.t = T0 + 5 * 60 * 1000 - 1;
  assertEquals(await accessToken(CFG, net.deps), "tok-1");
  net.clock.t = T0 + 5 * 60 * 1000;
  assertEquals(await accessToken(CFG, net.deps), "tok-2");
});

Deno.test("token：同時好幾個呼叫共用同一次換取", async () => {
  resetForTest();
  const net = fakeNet();
  const got = await Promise.all([accessToken(CFG, net.deps), accessToken(CFG, net.deps), accessToken(CFG, net.deps)]);
  assertEquals(got, ["tok-1", "tok-1", "tok-1"]);
  assertEquals(net.tokenCalls(), 1);
});

Deno.test("token：換不到回 null、不丟錯，30 秒內不再試（免得每次寫入都白等），之後再試", async () => {
  resetForTest();
  const net = fakeNet({ tokenStatus: 400 });
  const { result, logs } = await quiet(async () => await accessToken(CFG, net.deps));
  assertEquals(result, null);
  assertStringIncludes(logs, "換 token 失敗");
  assertEquals(await accessToken(CFG, net.deps), null);
  net.clock.t = T0 + TOKEN_FAIL_BACKOFF_MS - 1;
  assertEquals(await accessToken(CFG, net.deps), null);
  assertEquals(net.tokenCalls(), 1, "暫停期間不再打");
  net.clock.t = T0 + TOKEN_FAIL_BACKOFF_MS;
  await quiet(async () => await accessToken(CFG, net.deps));
  assertEquals(net.tokenCalls(), 2);
});

Deno.test("token：回應不是 JSON、沒有 access_token、私鑰壞掉、連線失敗，一律回 null", async () => {
  for (const make of [
    (): Deps => ({ ...fakeNet().deps, fetch: (() => Promise.resolve(new Response("<html>", { status: 200 }))) as typeof fetch }),
    (): Deps => ({ ...fakeNet().deps, fetch: (() => Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch }),
    (): Deps => ({ ...fakeNet().deps, fetch: (() => Promise.reject(new TypeError("offline"))) as typeof fetch }),
  ]) {
    resetForTest();
    assertEquals((await quiet(async () => await accessToken(CFG, make()))).result, null);
  }
  resetForTest();
  const bad = { dbUrl: DB, sa: { client_email: EMAIL, private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" } };
  assertEquals((await quiet(async () => await accessToken(bad, fakeNet().deps))).result, null);
});

// ── 路徑雜湊 ──

Deno.test("p 節點：穩定、不可猜（跟 owner 與服務帳戶私鑰都有關，不是 owner 的單純雜湊）", async () => {
  const owner = "5f0a0b0c-1111-4222-8333-944455556666";
  const a = await ownerPath(owner, CFG);
  assertEquals(a, await ownerPath(owner, CFG), "同樣輸入每次都一樣");
  assert(/^p\/[0-9a-f]{32}$/.test(a), a);
  assert(!a.includes(owner) && !a.includes(owner.replaceAll("-", "")), "路徑不含 owner");
  assertNotEquals(a, await ownerPath("5f0a0b0c-1111-4222-8333-944455556667", CFG), "不同使用者不同路徑");
  // 沒有私鑰就算不出來：用 owner 自己算的各種雜湊都對不上
  assertNotEquals(a, "p/" + (await sha256Hex("irori-signal-p:" + owner)).slice(0, 32));
  assertNotEquals(a, "p/" + (await sha256Hex("irori-state:" + owner)).slice(0, 32));
  assertNotEquals(a, "p/" + (await sha256Hex(owner)).slice(0, 32));
  const other = await makeKeys();
  assertNotEquals(a, await ownerPath(owner, { dbUrl: DB, sa: { client_email: EMAIL, private_key: other.pem } }), "換一把私鑰路徑就不同");
});

Deno.test("b 節點：sha256(\"irori-bell:\" + 頻道名) 前 32 碼（跟約定一致，irori-api 與 irori-relay 算出同一個）", async () => {
  const topic = "relay-bell-AbCdEf0123456789xyz_-";
  const expected = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("irori-bell:" + topic)))]
    .map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
  assertEquals(await bellPath(topic), `b/${expected}`);
  assertNotEquals(await bellPath(topic), await bellPath(topic + "x"));
});

Deno.test("網址：<db>/<節點>.json", () => {
  assertEquals(urlOf(CFG, "p/abc"), `${DB}/p/abc.json`);
});

// ── 寫入 ──

Deno.test("寫入：PUT <db>/<path>.json?access_token=…，body 是 JSON，有 3 秒逾時", async () => {
  resetForTest();
  const net = fakeNet();
  assertEquals(await put("p/abc", { seq: 5, state_seq: 2, speaker: null, at: T0 }, net.deps), true);
  const w = net.calls.find((c) => c.url.startsWith(DB))!;
  assertEquals(w.url, `${DB}/p/abc.json?access_token=tok-1`);
  assertEquals(w.init?.method, "PUT");
  assertEquals(JSON.parse(String(w.init?.body)), { seq: 5, state_seq: 2, speaker: null, at: T0 });
  assert(w.init?.signal, "要有逾時");
  assertEquals(net.tokenCalls(), 1);
  await put("/b/xyz", { at: 1 }, net.deps); // 開頭的斜線容忍
  assert(net.calls.some((c) => c.url === `${DB}/b/xyz.json?access_token=tok-1`));
  assertEquals(net.tokenCalls(), 1, "第二次寫入重用快取的 token");
});

Deno.test("沒設 secrets（config 回 null）：完全不寫，連 token 都不換，也不丟錯", async () => {
  resetForTest();
  const net = fakeNet();
  const off: Deps = { ...net.deps, config: () => null };
  assertEquals(await put("p/abc", { seq: 1 }, off), false);
  assertEquals(await putBell("relay-bell-x", off), false);
  assertEquals(net.calls.length, 0, "一個網路呼叫都沒有");
  assertEquals(enabled(off), false);
});

Deno.test("寫入失敗不丟錯：被拒、連不上、逾時、換不到 token 都只回 false 並記 log", async () => {
  resetForTest();
  for (const opts of [{ putStatus: 401 }, { putStatus: 403 }, { putStatus: 500 }, { putThrows: true }]) {
    resetForTest();
    const net = fakeNet(opts);
    const { result, logs } = await quiet(async () => await put("p/abc", { seq: 1 }, net.deps));
    assertEquals(result, false, JSON.stringify(opts));
    assertStringIncludes(logs, "signal 寫入");
  }
  resetForTest();
  const timeout: Deps = { ...fakeNet().deps, fetch: ((url: string) => url === TOKEN_URL
    ? Promise.resolve(new Response(JSON.stringify({ access_token: "t" }), { status: 200 }))
    : Promise.reject(new DOMException("The signal has timed out", "TimeoutError"))) as typeof fetch };
  assertEquals((await quiet(async () => await put("p/abc", {}, timeout))).result, false);
  resetForTest();
  assertEquals((await quiet(async () => await put("p/abc", {}, fakeNet({ tokenStatus: 500 }).deps))).result, false);
  resetForTest();
  assertEquals((await quiet(async () => await put("p/abc", {}, { ...fakeNet().deps, config: () => { throw new Error("config 壞了"); } }))).result, false);
});

Deno.test("寫入被 401 拒絕：丟掉快取的 token，下次重換", async () => {
  resetForTest();
  const net = fakeNet({ putStatus: 401 });
  await quiet(async () => await put("p/abc", {}, net.deps));
  assertEquals(net.tokenCalls(), 1);
  await quiet(async () => await put("p/abc", {}, net.deps));
  assertEquals(net.tokenCalls(), 2);
});

Deno.test("log 不洩漏 access token（Deno 的連線錯誤訊息會帶出整條網址）", async () => {
  resetForTest();
  const net = fakeNet({ putThrows: true });
  const { logs } = await quiet(async () => await put("p/abc", {}, net.deps));
  assert(logs.length > 0);
  assert(!logs.includes("tok-1"), logs);
  assertStringIncludes(logs, "access_token=***");
  assertEquals(redact("x https://a/b.json?access_token=ya29.AbC-d_e&y=1 z"), "x https://a/b.json?access_token=***&y=1 z");
});

Deno.test("敲門鈴的 b 節點：寫 b/<hash> ＝ { at }，沒有任何內容", async () => {
  resetForTest();
  const net = fakeNet();
  const topic = "relay-bell-AbCdEf";
  assertEquals(await putBell(topic, net.deps), true);
  const w = net.calls.find((c) => c.url.startsWith(DB))!;
  assertEquals(w.url, `${DB}/${await bellPath(topic)}.json?access_token=tok-1`);
  assertEquals(JSON.parse(String(w.init?.body)), { at: T0 });
});

Deno.test("保底輪詢間隔是 300 秒（前端 signal.poll_s；小良哥裁示 5 分鐘）", () => {
  assertEquals(POLL_S, 300);
});
