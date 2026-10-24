import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { approveCorsHeaders, type DeviceCodeDeps, handleDeviceCodeAction, normalizeUserCode, USER_CODE_RE } from "./device_code.ts";

const sha = async (s: string) => "H(" + s + ")";

function mk(over: Partial<DeviceCodeDeps> = {}, rpcLog: Array<[string, Record<string, unknown>]> = []) {
  const deps: DeviceCodeDeps = {
    rpc: async (fn, args) => { rpcLog.push([fn, args]); return { data: {}, error: null }; },
    verifyJwt: async (t) => (t === "good-token-good-token-good" ? { id: "11111111-1111-1111-1111-111111111111", email: null, name: null } : null),
    sha256Hex: sha,
    newCodes: () => ({ userCode: "ABCD-2345", deviceCode: "DEVICECODE" }),
    newSecrets: () => ({ key: "SECRETKEY", bellTopic: "bell-x" }),
    ...over,
  };
  return { deps, rpcLog };
}

Deno.test("短碼格式與正規化：大小寫、空白、連字號都容忍；不含易混字元", () => {
  assertEquals(normalizeUserCode(" abcd 2345 "), "ABCD-2345");
  assertEquals(normalizeUserCode("abcd-2345"), "ABCD-2345");
  assertEquals(normalizeUserCode("ABCD23456"), null);
  assertEquals(normalizeUserCode("ABCD-23O5"), null, "O 不在字母表");
  assert(USER_CODE_RE.test("ABCD-2345"));
});

Deno.test("start：回短碼、裝置碼、到期與間隔；資料庫只收雜湊", async () => {
  const log: Array<[string, Record<string, unknown>]> = [];
  const realSha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const { deps } = mk({ sha256Hex: realSha, rpc: async (fn, args) => { log.push([fn, args]); return { data: { expires_at: "2026-01-01T00:15:00Z", interval: 5 }, error: null }; } });
  const r = await handleDeviceCodeAction(deps, "device_code_start", { ip: "1.2.3.4", authHeader: null, body: null });
  assertEquals(r.status, 200);
  assertEquals(r.body.user_code, "ABCD-2345");
  assertEquals(r.body.device_code, "DEVICECODE");
  assertEquals(r.body.expires_in, 900);
  assertEquals(r.body.interval, 5);
  const args = log[0][1];
  assertEquals(log[0][0], "asn_device_code_start");
  assertNotEquals(args.p_device_hash, "DEVICECODE");
  assertEquals(JSON.stringify(args).includes("ABCD"), false, "資料庫不收明文短碼");
  assertEquals(JSON.stringify(args).includes("DEVICECODE"), false, "資料庫不收明文裝置碼");
});

Deno.test("start：短碼撞到就重抽；頻率限制回 429", async () => {
  let n = 0;
  const { deps } = mk({
    rpc: async () => (++n < 3 ? { data: { error: "collision" }, error: null } : { data: { expires_at: "x", interval: 5 }, error: null }),
  });
  assertEquals((await handleDeviceCodeAction(deps, "device_code_start", { ip: "i", authHeader: null, body: null })).status, 200);
  assertEquals(n, 3);
  const lim = mk({ rpc: async () => ({ data: { error: "rate_limited" }, error: null }) });
  const r = await handleDeviceCodeAction(lim.deps, "device_code_start", { ip: "i", authHeader: null, body: null });
  assertEquals([r.status, r.body.error], [429, "rate_limited"]);
});

Deno.test("approve：沒帶／壞登入憑證 401，不碰資料庫；短碼格式錯 400 不碰資料庫", async () => {
  const { deps, rpcLog } = mk();
  for (const h of [null, "Bearer short", "Bearer bad-token-bad-token-bad-token"]) {
    const r = await handleDeviceCodeAction(deps, "device_code_approve", { ip: "i", authHeader: h, body: { user_code: "ABCD-2345", name: "x" } });
    assertEquals(r.status, 401);
  }
  const r2 = await handleDeviceCodeAction(deps, "device_code_approve", { ip: "i", authHeader: "Bearer good-token-good-token-good", body: { user_code: "zzzz", name: "x" } });
  assertEquals(r2.status, 400);
  assertEquals(rpcLog.length, 0);
});

Deno.test("approve：帶登入憑證的使用者 id、短碼雜湊、代號與顯示名；錯誤碼對應狀態", async () => {
  const log: Array<[string, Record<string, unknown>]> = [];
  const { deps } = mk({ rpc: async (fn, args) => { log.push([fn, args]); return { data: { id: "t1-box", name: "盒子" }, error: null }; } });
  const auth = "Bearer good-token-good-token-good";
  const r = await handleDeviceCodeAction(deps, "device_code_approve", { ip: "i", authHeader: auth, body: { user_code: "abcd 2345", node_id: "t1-box", name: "盒子" } });
  assertEquals([r.status, r.body], [200, { ok: true, id: "t1-box", name: "盒子" }]);
  assertEquals(log[0][0], "asn_device_code_approve");
  assertEquals(log[0][1].p_user, "11111111-1111-1111-1111-111111111111");
  assertEquals(log[0][1].p_user_hash, "H(dc-user:ABCD-2345)");
  assertEquals(log[0][1].p_node_id, "t1-box");
  assertEquals(log[0][1].p_name, "盒子");
  const cases: Array<[string, number]> = [["invalid_code", 404], ["rate_limited", 429], ["id_taken", 409], ["bad_id_prefix", 403], ["too_many", 429], ["tenant_inactive", 403], ["bad_request", 400]];
  for (const [code, status] of cases) {
    const { deps: d } = mk({ rpc: async () => ({ data: { error: code, prefix: "t1-" }, error: null }) });
    const e = await handleDeviceCodeAction(d, "device_code_approve", { ip: "i", authHeader: auth, body: { user_code: "ABCD-2345", name: "x" } });
    assertEquals([code, e.status, e.body.error], [code, status, code]);
  }
  // 不指定代號時 p_node_id 為 null；名字缺＝400
  const log2: Array<[string, Record<string, unknown>]> = [];
  const { deps: d2 } = mk({ rpc: async (fn, a) => { log2.push([fn, a]); return { data: { id: "n1", name: "x" }, error: null }; } });
  await handleDeviceCodeAction(d2, "device_code_approve", { ip: "i", authHeader: auth, body: { user_code: "ABCD-2345", name: "x" } });
  assertEquals(log2[0][1].p_node_id, null);
  const bad = await handleDeviceCodeAction(d2, "device_code_approve", { ip: "i", authHeader: auth, body: { user_code: "ABCD-2345" } });
  assertEquals(bad.status, 400);
});

Deno.test("poll：等待、核准後回金鑰（只此一次）、到期、無此碼；金鑰雜湊才送資料庫", async () => {
  const log: Array<[string, Record<string, unknown>]> = [];
  const resp: Record<string, unknown>[] = [
    { status: "pending" }, { status: "approved", id: "t1-box", bell_topic: "bell-x" }, { status: "expired" },
    { error: "invalid_device_code" }, { error: "slow_down" },
  ];
  const { deps } = mk({ rpc: async (fn, args) => { log.push([fn, args]); return { data: resp.shift(), error: null }; } });
  const call = () => handleDeviceCodeAction(deps, "device_code_poll", { ip: "i", authHeader: null, body: { device_code: "DEVICECODE" } });
  const p = await call();
  assertEquals([p.status, p.body.status], [200, "pending"]);
  const a = await call();
  assertEquals(a.status, 200);
  assertEquals(a.body, { status: "approved", id: "t1-box", key: "SECRETKEY", bell_topic: "bell-x" });
  assertEquals(log[1][1].p_key_hash, "H(SECRETKEY)");
  assertEquals(log[1][1].p_device_hash, "H(dc-device:DEVICECODE)");
  const e = await call();
  assertEquals([e.status, e.body.error, "key" in e.body], [410, "expired", false]);
  assertEquals((await call()).status, 404);
  assertEquals((await call()).status, 429);
  const bad = await handleDeviceCodeAction(deps, "device_code_poll", { ip: "i", authHeader: null, body: {} });
  assertEquals(bad.status, 400);
});

Deno.test("守門：index.ts 在節點金鑰驗證之前接上三個動作；send 把 not_receivable 回 409；紀錄不印金鑰", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  const iDevice = src.indexOf("DEVICE_CODE_ACTIONS.has(action)");
  const iAuth = src.indexOf('const key = req.headers.get("x-relay-key")');
  assert(iDevice > 0 && iAuth > 0 && iDevice < iAuth, "裝置授權動作必須排在節點金鑰驗證之前");
  assert(src.includes('"not_receivable"') && src.includes("409"), "send 要把 not_receivable 回 409");
  const mod = await Deno.readTextFile(new URL("./device_code.ts", import.meta.url));
  assertEquals(/console\.\w+\([^)]*(key|code)/i.test(mod.replace(/console\.error\("device_code_\w+", error\)/g, "")), false);
});

Deno.test("網頁核准頁的跨來源許可：只有官網網域、只有 approve 動作；其他一律不給", () => {
  const ok = approveCorsHeaders("https://asnmessenger.web.app", "device_code_approve");
  assert(ok !== null);
  assertEquals(ok!["access-control-allow-origin"], "https://asnmessenger.web.app");
  assertEquals(ok!["access-control-allow-headers"], "authorization, content-type");
  assertEquals(ok!["access-control-allow-methods"], "POST, OPTIONS");
  assertEquals(ok!["vary"], "origin");
  assert(!("access-control-allow-credentials" in ok!), "不帶 cookie 憑證");
  assertEquals(approveCorsHeaders("https://evil.example", "device_code_approve"), null);
  assertEquals(approveCorsHeaders("https://asnmessenger.web.app.evil.example", "device_code_approve"), null);
  assertEquals(approveCorsHeaders(null, "device_code_approve"), null);
  assertEquals(approveCorsHeaders("https://asnmessenger.web.app", "device_code_start"), null, "start 不開網頁");
  assertEquals(approveCorsHeaders("https://asnmessenger.web.app", "device_code_poll"), null, "poll 會回金鑰，絕不開網頁");
  assertEquals(approveCorsHeaders("https://asnmessenger.web.app", "whoami"), null);
});
