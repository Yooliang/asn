import { assert, assertEquals } from "jsr:@std/assert@1";
import { createFcm, FCM_SCOPE, PUSH_BODY, PUSH_CHANNEL, PUSH_TAG, PUSH_TITLE, pushMessage } from "./push_fcm.ts";

const DEVICE = "d".repeat(40) + ":APA91b_secret-device-token";
const ACCESS = "ya29.secret-access-token";

const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
const PEM = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
const ACCOUNT = JSON.stringify({ client_email: "push@asnmessenger.iam.gserviceaccount.com", private_key: PEM, project_id: "asnmessenger" });
const env = (v: Record<string, string>) => ({ get: (k: string) => v[k] });
const unb64 = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

type Call = { url: string; init: RequestInit };
function fakeFetch(opts: { fcm?: (n: number) => Response; token?: () => Response } = {}) {
  const calls: Call[] = [];
  let sends = 0;
// deno-lint-ignore require-await
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url === "https://oauth2.googleapis.com/token") return opts.token ? opts.token() : new Response(JSON.stringify({ access_token: ACCESS, expires_in: 3600 }));
    sends++;
    return opts.fcm ? opts.fcm(sends) : new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { f, calls };
}

// 抓 console，確認權杖、存取權杖、私鑰不會進 log
async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const orig = { w: console.warn, e: console.error, l: console.log, i: console.info };
  const rec = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.warn = console.error = console.log = console.info = rec;
  try { await fn(); } finally { console.warn = orig.w; console.error = orig.e; console.log = orig.l; console.info = orig.i; }
  return out.join("\n");
}

Deno.test("沒設秘密或格式不對：createFcm 是 null（安靜不送）", () => {
  assertEquals(createFcm(env({})), null);
  assertEquals(createFcm(env({ FCM_SERVICE_ACCOUNT: "不是 JSON" })), null);
  assertEquals(createFcm(env({ FCM_SERVICE_ACCOUNT: JSON.stringify({ client_email: "a", private_key: "b" }) })), null);
  assertEquals(createFcm(env({ FCM_SERVICE_ACCOUNT: JSON.stringify({ client_email: "a", private_key: "b", project_id: "x/../y" }) })), null, "專案代號要像專案代號");
});

Deno.test("送出的內容逐字等於固定文字，沒有 data 欄位", async () => {
  const { f, calls } = fakeFetch();
  const r = await createFcm(env({ FCM_SERVICE_ACCOUNT: ACCOUNT }), f)!.send(DEVICE);
  assertEquals(r, { status: 200, invalid: false });
  const send = calls.find((c) => c.url.includes("fcm.googleapis.com"))!;
  assertEquals(send.url, "https://fcm.googleapis.com/v1/projects/asnmessenger/messages:send");
  assertEquals((send.init.headers as Record<string, string>).authorization, `Bearer ${ACCESS}`);
  const body = JSON.parse(String(send.init.body));
  assertEquals(body, {
    message: {
      token: DEVICE,
      notification: { title: "ASN", body: "ASN 有新訊息" },
      android: { collapse_key: "asn-new-message", priority: "HIGH", notification: { tag: "asn-new-message", channel_id: "asn_messages" } },
    },
  });
  assertEquals(Object.keys(body.message).sort(), ["android", "notification", "token"], "message 底下沒有 data");
  assertEquals([PUSH_TITLE, PUSH_BODY, PUSH_TAG, PUSH_CHANNEL], ["ASN", "ASN 有新訊息", "asn-new-message", "asn_messages"]);
  assertEquals(JSON.stringify(pushMessage("t")).includes("data"), false);
});

Deno.test("換存取權杖：JWT 簽章驗得過、範圍只有 firebase.messaging、快取後不重換", async () => {
  const { f, calls } = fakeFetch();
  const fcm = createFcm(env({ FCM_SERVICE_ACCOUNT: ACCOUNT }), f)!;
  await fcm.send(DEVICE);
  await fcm.send(DEVICE);
  const tokenCalls = calls.filter((c) => c.url === "https://oauth2.googleapis.com/token");
  assertEquals(tokenCalls.length, 1, "存取權杖放記憶體重複用");
  const form = new URLSearchParams(String(tokenCalls[0].init.body));
  assertEquals(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [h, c, s] = form.get("assertion")!.split(".");
  assertEquals(JSON.parse(new TextDecoder().decode(unb64(h))), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(new TextDecoder().decode(unb64(c)));
  assertEquals(claims.scope, FCM_SCOPE);
  assertEquals(claims.scope, "https://www.googleapis.com/auth/firebase.messaging");
  assertEquals(claims.iss, "push@asnmessenger.iam.gserviceaccount.com");
  assertEquals(claims.aud, "https://oauth2.googleapis.com/token");
  assert(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", kp.publicKey, unb64(s), new TextEncoder().encode(`${h}.${c}`)), "簽章要用服務帳戶私鑰簽");
});

Deno.test("401：換一把存取權杖再試一次；404／UNREGISTERED＝權杖失效", async () => {
  let n = 0;
  const a = fakeFetch({ fcm: (i) => (i === 1 ? new Response("{}", { status: 401 }) : new Response("{}", { status: 200 })), token: () => new Response(JSON.stringify({ access_token: ACCESS + (++n), expires_in: 3600 })) });
  assertEquals(await createFcm(env({ FCM_SERVICE_ACCOUNT: ACCOUNT }), a.f)!.send(DEVICE), { status: 200, invalid: false });
  assertEquals(n, 2, "401 之後重換一次");
  const b = fakeFetch({ fcm: () => new Response("{}", { status: 404 }) });
  assertEquals(await createFcm(env({ FCM_SERVICE_ACCOUNT: ACCOUNT }), b.f)!.send(DEVICE), { status: 404, invalid: true });
  const body = JSON.stringify({ error: { status: "NOT_FOUND", details: [{ "@type": "x", errorCode: "UNREGISTERED" }] } });
  const c = fakeFetch({ fcm: () => new Response(body, { status: 400 }) });
  assertEquals((await createFcm(env({ FCM_SERVICE_ACCOUNT: ACCOUNT }), c.f)!.send(DEVICE)).invalid, true);
  const d = fakeFetch({ fcm: () => new Response(JSON.stringify({ error: { status: "INVALID_ARGUMENT" } }), { status: 400 }) });
  assertEquals(await createFcm(env({ FCM_SERVICE_ACCOUNT: ACCOUNT }), d.f)!.send(DEVICE), { status: 400, invalid: false }, "單純 400 先不算權杖壞");
});

Deno.test("log 不出現權杖、存取權杖、私鑰：換權杖失敗、送出丟例外、FCM 回錯誤內文", async () => {
  const bad = fakeFetch({ token: () => new Response(`denied ${ACCESS} ${PEM}`, { status: 400 }) });
  const t1 = await captureLogs(async () => { assertEquals((await createFcm(env({ FCM_SERVICE_ACCOUNT: ACCOUNT }), bad.f)!.send(DEVICE)).status, 0); });
  // deno-lint-ignore require-await
  const thrower = (async () => { throw new Error(`boom ${DEVICE} ${ACCESS} ${PEM}`); }) as unknown as typeof fetch;
  const t2 = await captureLogs(async () => { assertEquals((await createFcm(env({ FCM_SERVICE_ACCOUNT: ACCOUNT }), thrower)!.send(DEVICE)).status, 0); });
  const echo = fakeFetch({ fcm: () => new Response(`echo ${DEVICE} ${ACCESS}`, { status: 500 }) });
  const t3 = await captureLogs(async () => { assertEquals((await createFcm(env({ FCM_SERVICE_ACCOUNT: ACCOUNT }), echo.f)!.send(DEVICE)).status, 500); });
  for (const t of [t1, t2, t3]) {
    for (const secret of [DEVICE, ACCESS, "BEGIN PRIVATE KEY", PEM.slice(40, 80)]) assertEquals(t.includes(secret), false, `log 含 ${secret.slice(0, 12)}…`);
  }
  assert(t1.includes("400"), "只記狀態碼");
});
