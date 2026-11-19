// 網頁版閘道（web_session.ts）的測試：身分、放行清單（預設拒絕）、缺 session_id、登出、跨來源許可、帳號動作先過放行清單、網頁憑證不能走網頁路線之外。
// 執行：SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno test -A supabase/functions/_shared/
import { assert, assertEquals } from "jsr:@std/assert@1";
import { ACCOUNT_ACTIONS, type AuthUser } from "./account.ts";
import { ACCT_ACTIONS } from "./account_switch.ts";
import { ACTIONS as ATTACH_ACTIONS } from "./attachments.ts";
import { DEVICE_CODE_ACTIONS } from "./device_code.ts";
import { DEVICE_PAIR_ACTIONS } from "./device_pair.ts";
import { GROUP_ACTIONS } from "./groups.ts";
import { LAUNCH_ACTIONS } from "./launch.ts";
import { PARTNER_OP_ACTIONS } from "./partner_ops.ts";
import { PERM_REQ_ACTIONS } from "./perm_request.ts";
import { PUSH_ACTIONS } from "./push_ctl.ts";
import { QUOTA_SHARE_ACTIONS } from "./quota_read.ts";
import { OWNER_ONLY_ACTIONS } from "./rooms.ts";
import { SECRET_ACTIONS } from "./secret_remote.ts";
import { SITE_ACTIONS } from "./site_write.ts";
import { TERM_REQ_ACTIONS } from "./term_request.ts";
import { TERM_VIEW_ACTIONS } from "./term_view_ctl.ts";
import { USAGE_ACTIONS } from "./usage.ts";
import {
  browserLabel, gateWebRequest, handleWebAction, isWebOrigin, memoVerify, sessionIdOfToken, WEB_ALLOWED_ACTIONS, WEB_DENIED_ACTIONS, WEB_FORBIDDEN,
  webCorsHeaders, webCredentialCheck, type WebDeps, webOrigins, webPreflight, type WebRequestInfo, withWebCors,
} from "./web_session.ts";

const WEB = "https://web.example.test";
const USER = "99999999-9999-4999-8999-999999999999";
const SID = "11111111-1111-4111-8111-111111111111";
const DEVICE = "d".repeat(32);
const TOKEN = "a.b.c-token-with-enough-length-0123456789";
const NODE = { id: "w1", bell_topic: "relay-bell-w1", role: "member", tenant_id: "t-1" };

type Call = { fn: string; args: Record<string, unknown> };

function fake(o: { user?: Partial<AuthUser> | null; touch?: unknown; sessionIsWeb?: boolean; origins?: string[] } = {}) {
  const calls: Call[] = [];
  const deps: WebDeps = {
    origins: o.origins ?? [WEB],
    verifyJwt: (t) => Promise.resolve(t === TOKEN || t.startsWith("tok-") ? (o.user === null ? null : { id: USER, email: null, name: null, sessionId: SID, ...(o.user ?? {}) }) : null),
    sha256Hex: (s) => Promise.resolve("h(" + s + ")"),
    rpc: (fn, args) => {
      calls.push({ fn, args });
      if (fn === "asn_relay_web_touch") return Promise.resolve({ data: o.touch ?? { node: NODE, created: false }, error: null });
      if (fn === "asn_relay_web_session_is_web") return Promise.resolve({ data: o.sessionIsWeb ?? false, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { deps, calls };
}

const req = (o: Partial<WebRequestInfo> = {}): WebRequestInfo => ({
  action: "list", origin: WEB, hasKey: false, device: DEVICE, userHeader: "Bearer " + TOKEN, userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537", ...o,
});

Deno.test("網頁節點打 list：通過，拿到網頁節點；舊程式沒有這條分支（沒金鑰一律 401）", async () => {
  const { deps, calls } = fake();
  const g = await gateWebRequest(deps, req());
  assertEquals(g.kind, "web");
  if (g.kind === "web") {
    assertEquals(g.me, NODE);
    assertEquals(g.sessionId, SID);
    assertEquals(g.user.id, USER);
  }
  assertEquals(calls.length, 1);
  assertEquals(calls[0].args.p_create, true, "放行清單內的動作才可以建立登入記錄");
  assertEquals(calls[0].args.p_device_hash, "h(asn-web-device:" + DEVICE + ")", "瀏覽器代號只以雜湊送進資料庫");
  assertEquals(calls[0].args.p_label, "Chrome（Windows）");
});

Deno.test("放行清單內的每個動作都能通過", async () => {
  for (const a of WEB_ALLOWED_ACTIONS) {
    const g = await gateWebRequest(fake().deps, req({ action: a }));
    assertEquals(g.kind, "web", a);
  }
});

Deno.test("node_create 與各種決定類動作：403 web_forbidden（新定義的錯誤碼），不建立登入記錄", async () => {
  for (const a of ["node_create", "node_claim", "perm_req_decide", "term_req_decide", "secret_reply", "group_confirm_decide", "launch", "term_view_start", "acct_switch", "device_code_approve", "register", "reissue", "invite"]) {
    // 已登記的網頁
    const known = await gateWebRequest(fake().deps, req({ action: a }));
    assertEquals(known.kind === "reply" ? [known.status, known.body.error] : known.kind, [403, WEB_FORBIDDEN], a);
    // 沒登記過的瀏覽器：也是 403，而且資料庫呼叫要求不建立
    const f = fake({ touch: { error: "unknown" } });
    const fresh = await gateWebRequest(f.deps, req({ action: a }));
    assertEquals(fresh.kind === "reply" ? [fresh.status, fresh.body.error] : fresh.kind, [403, WEB_FORBIDDEN], a);
    assertEquals(f.calls[0].args.p_create, false, a + "：不能因為打了禁止的動作就建立登入記錄");
  }
});

Deno.test("沒帶動作、不認得的動作：一律拒絕（預設拒絕）", async () => {
  for (const a of [null, "", "brand_new_action", "room_whatever", "web_other"]) {
    const g = await gateWebRequest(fake().deps, req({ action: a }));
    assertEquals(g.kind === "reply" ? [g.status, g.body.error] : g.kind, [403, WEB_FORBIDDEN], String(a));
  }
});

Deno.test("帳號動作（ACCOUNT_ACTIONS）：網頁憑證打進來一律先過放行清單，全部 403，不會被當成帳號動作處理", async () => {
  for (const a of ACCOUNT_ACTIONS) {
    assert(!WEB_ALLOWED_ACTIONS.has(a), a + " 不在放行清單");
    // 帶 Authorization 的帳號動作寫法也一樣：閘道看的是登入憑證標頭，動作不在清單就 403
    const g = await gateWebRequest(fake().deps, req({ action: a }));
    assertEquals(g.kind === "reply" ? g.status : g.kind, 403, a);
  }
});

Deno.test("網頁來源沒有 session_id：一律拒絕（401）；走網頁路線（帶瀏覽器代號）也一樣", async () => {
  for (const origin of [WEB, null]) {
    const f = fake({ user: { sessionId: null } });
    const g = await gateWebRequest(f.deps, req({ origin }));
    assertEquals(g.kind === "reply" ? [g.status, g.body.error] : g.kind, [401, "unauthorized"]);
    assertEquals(f.calls, [], "不打資料庫");
  }
  const bad = await gateWebRequest(fake({ user: { sessionId: "not-a-uuid" } }).deps, req());
  assertEquals(bad.kind === "reply" ? bad.status : bad.kind, 401);
});

Deno.test("電腦與手機的路徑照舊：沒有瀏覽器代號、也不是網頁來源，不管憑證有沒有 session_id 都不進網頁分支", async () => {
  const f = fake({ user: { sessionId: null } });
  for (const o of [
    { device: null, origin: null, hasKey: true }, // 一般節點金鑰請求
    { device: null, origin: null, hasKey: false }, // 沒金鑰（之後由原本的 401 處理）
    { device: null, origin: "https://other.example.test", hasKey: true, userHeader: "Bearer " + TOKEN },
    { device: DEVICE, origin: null, hasKey: true }, // 帶金鑰的非網頁來源：照舊
  ]) {
    assertEquals((await gateWebRequest(f.deps, req(o))).kind, "none");
  }
  assertEquals(f.calls, []);
});

Deno.test("網頁來源帶節點金鑰：403（網頁不持有金鑰）", async () => {
  const g = await gateWebRequest(fake().deps, req({ hasKey: true }));
  assertEquals(g.kind === "reply" ? [g.status, g.body.error] : g.kind, [403, WEB_FORBIDDEN]);
});

Deno.test("被登出的網頁打任何動作都回 401（放行與禁止的動作都一樣）", async () => {
  for (const a of ["list", "inbox", "web_sessions_list", "node_create", "perm_req_decide", "whatever"]) {
    for (const error of ["signed_out", "forbidden"]) {
      const g = await gateWebRequest(fake({ touch: { error } }).deps, req({ action: a }));
      assertEquals(g.kind === "reply" ? [g.status, g.body.error] : g.kind, [401, "unauthorized"], a + "/" + error);
    }
  }
});

Deno.test("憑證無效、瀏覽器代號格式不對、沒有登入憑證標頭：401", async () => {
  for (const o of [{ userHeader: null }, { userHeader: "Bearer tok-" + "x".repeat(20) + "!bad" }, { device: "short" }, { device: null, origin: WEB }, { userHeader: "Bearer " + "z".repeat(30) }]) {
    const g = await gateWebRequest(fake().deps, req(o));
    assertEquals(g.kind === "reply" ? g.status : g.kind, 401, JSON.stringify(o));
  }
  const g = await gateWebRequest(fake({ user: null }).deps, req());
  assertEquals(g.kind === "reply" ? g.status : g.kind, 401);
});

Deno.test("資料庫回的各種錯誤：名額滿 429、帳號停用 403、其他 400；資料庫壞掉 500", async () => {
  const code = async (touch: unknown) => {
    const g = await gateWebRequest(fake({ touch }).deps, req());
    return g.kind === "reply" ? g.status : g.kind;
  };
  assertEquals(await code({ error: "too_many" }), 429);
  assertEquals(await code({ error: "tenant_inactive" }), 403);
  assertEquals(await code({ error: "something_else" }), 400);
  assertEquals(await code({ error: "bad_request" }), 401);
  assertEquals(await code({ node: { id: 1 } }), 500, "節點資料不完整");
  const f = fake();
  f.deps.rpc = () => Promise.resolve({ data: null, error: { message: "boom" } });
  const g = await gateWebRequest(f.deps, req());
  assertEquals(g.kind === "reply" ? g.status : g.kind, 500);
});

Deno.test("新瀏覽器第一次登入：把資料庫寄出的通知交給呼叫端（敲門鈴、推手機）；一般請求不帶", async () => {
  const notice = { notify: "sent", bell_topics: ["b1", "b2", 5], mail_id: "m-1" };
  const first = await gateWebRequest(fake({ touch: { node: NODE, created: true, first: true, notice } }).deps, req());
  assertEquals(first.kind === "web" ? first.notice : "x", { notify: "sent", bell_topics: ["b1", "b2"], mail_id: "m-1" });
  const again = await gateWebRequest(fake({ touch: { node: NODE, created: true, first: false, notice: null } }).deps, req());
  assertEquals(again.kind === "web" ? again.notice : "x", null);
  const plain = await gateWebRequest(fake().deps, req());
  assertEquals(plain.kind === "web" ? plain.notice : "x", null);
});

Deno.test("跨來源：預檢只認網頁版網域；回確切網址、不用 *、不允許帶 cookie；其他來源沒有任何許可標頭", () => {
  const origins = [WEB];
  const pre = (origin: string | null) => webPreflight(origins, new Request("https://x.test/relay?action=list", { method: "OPTIONS", headers: origin ? { origin } : {} }));
  const ok = pre(WEB)!;
  assertEquals(ok.status, 204);
  assertEquals(ok.headers.get("access-control-allow-origin"), WEB);
  assertEquals(ok.headers.get("vary"), "origin");
  assertEquals(ok.headers.get("access-control-allow-credentials"), null);
  assert(ok.headers.get("access-control-allow-headers")!.includes("x-asn-web") && ok.headers.get("access-control-allow-headers")!.includes("x-asn-user"));
  for (const o of ["https://evil.example.test", WEB + ".evil.test", "http://web.example.test", "https://web.example.test:8443", "null", null]) {
    assertEquals(pre(o), null, String(o));
    assertEquals(webCorsHeaders(origins, o), null, String(o));
  }
  assertEquals(webPreflight(origins, new Request("https://x.test", { method: "GET", headers: { origin: WEB } })), null, "不是預檢");
  assertEquals(webPreflight([], new Request("https://x.test", { method: "OPTIONS", headers: { origin: WEB } })), null, "沒設網域＝誰都不給");
  // 一般回應補標頭：網頁來源有，其他來源原樣
  const res = withWebCors(origins, new Request("https://x.test", { headers: { origin: WEB } }), new Response("{}", { status: 403 }));
  assertEquals([res.status, res.headers.get("access-control-allow-origin")], [403, WEB]);
  const other = withWebCors(origins, new Request("https://x.test", { headers: { origin: "https://evil.example.test" } }), new Response("{}"));
  assertEquals(other.headers.get("access-control-allow-origin"), null);
});

Deno.test("網域設定：只收 https（或本機測試用的 http://localhost）的確切網址；其他值略過；沒設是空", () => {
  assertEquals(webOrigins(() => undefined), []);
  assertEquals(webOrigins(() => ""), []);
  assertEquals(webOrigins(() => " https://a.test , http://localhost:5173 ,https://b.test/ , http://a.test, https://c.test/path, nonsense, *"), ["https://a.test", "http://localhost:5173", "https://b.test"]);
  assert(isWebOrigin(["https://a.test"], "https://a.test") && !isWebOrigin(["https://a.test"], "https://a.test/") && !isWebOrigin([], "https://a.test") && !isWebOrigin(["https://a.test"], null));
});

// ---- session_id 解碼 ----
const b64u = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (payload: unknown) => `${b64u({ alg: "ES256" })}.${b64u(payload)}.sig`;

Deno.test("sessionIdOfToken：取同一個憑證裡的 session_id；格式不對、沒有、sub 對不上都是 null", () => {
  assertEquals(sessionIdOfToken(jwt({ sub: USER, session_id: SID }), USER), SID);
  assertEquals(sessionIdOfToken(jwt({ sub: USER, session_id: SID.toUpperCase() })), SID, "一律小寫");
  assertEquals(sessionIdOfToken(jwt({ sub: USER })), null, "缺值");
  assertEquals(sessionIdOfToken(jwt({ sub: USER, session_id: "abc" })), null);
  assertEquals(sessionIdOfToken(jwt({ sub: USER, session_id: 5 })), null);
  assertEquals(sessionIdOfToken(jwt({ sub: "someone-else", session_id: SID }), USER), null);
  assertEquals(sessionIdOfToken("not-a-jwt"), null);
  assertEquals(sessionIdOfToken("a.%%%.c"), null);
});

// ---- 網頁憑證不能走網頁路線之外 ----
Deno.test("網頁登入的憑證在網頁路線之外：被認出是網頁（回 web），呼叫端回 403；一般憑證與沒有 session_id 的憑證不受影響", async () => {
  const web = fake({ sessionIsWeb: true });
  assertEquals(await webCredentialCheck(web.deps, [null, TOKEN], new Map()), "web");
  const plain = fake({ sessionIsWeb: false });
  assertEquals(await webCredentialCheck(plain.deps, [TOKEN], new Map()), "no");
  const none = fake({ user: { sessionId: null }, sessionIsWeb: true });
  assertEquals(await webCredentialCheck(none.deps, [TOKEN], new Map()), "no", "缺 session_id＝電腦與手機的舊憑證，照舊");
  assertEquals(none.calls, []);
  assertEquals(await webCredentialCheck(plain.deps, [null, undefined], new Map()), "no");
  // 兩個憑證任一個是網頁就擋
  assertEquals(await webCredentialCheck(web.deps, ["tok-1" + "x".repeat(20), TOKEN], new Map()), "web");
});

Deno.test("網頁憑證檢查：資料庫查不出來時寧可擋（error）；網頁 session 永久記住；一般 session 只記一分鐘", async () => {
  const f = fake();
  f.deps.rpc = () => Promise.resolve({ data: null, error: { message: "down" } });
  assertEquals(await webCredentialCheck(f.deps, [TOKEN], new Map()), "error");
  const g = fake();
  g.deps.verifyJwt = () => Promise.reject(new Error("net"));
  assertEquals(await webCredentialCheck(g.deps, [TOKEN], new Map()), "error");
  // 快取
  let t = 1000;
  const cache = new Map<string, number>();
  const a = fake({ sessionIsWeb: false });
  await webCredentialCheck(a.deps, [TOKEN], cache, () => t);
  await webCredentialCheck(a.deps, [TOKEN], cache, () => t + 30_000);
  assertEquals(a.calls.filter((c) => c.fn === "asn_relay_web_session_is_web").length, 1, "一分鐘內不重查");
  await webCredentialCheck(a.deps, [TOKEN], cache, () => t + 61_000);
  assertEquals(a.calls.filter((c) => c.fn === "asn_relay_web_session_is_web").length, 2);
  const w = fake({ sessionIsWeb: true });
  const c2 = new Map<string, number>();
  await webCredentialCheck(w.deps, [TOKEN], c2, () => t);
  t += 10 * 3600_000;
  assertEquals(await webCredentialCheck(w.deps, [TOKEN], c2, () => t), "web");
  assertEquals(w.calls.length, 1, "網頁 session 查一次就永久記住");
});

// ---- 網頁專用動作 ----
Deno.test("web_sessions_list／web_logout_all：只用閘道驗過的使用者；登出回網頁節點的門鈴", async () => {
  const calls: Call[] = [];
  const rpc: WebDeps["rpc"] = (fn, args) => {
    calls.push({ fn, args });
    return Promise.resolve({ data: fn === "asn_relay_web_logout_all" ? { count: 2, bell_topics: ["b1", 7, "b2"] } : [{ node: "w1", browser: "Chrome（Windows）", current: true }], error: null });
  };
  const who = { user: { id: USER, email: null, name: null }, sessionId: SID };
  const l = await handleWebAction({ rpc }, "web_sessions_list", who);
  assertEquals([l?.status, (l?.body.sessions as unknown[]).length], [200, 1]);
  assertEquals(calls[0], { fn: "asn_relay_web_sessions_list", args: { p_user: USER, p_session: SID } });
  const o = await handleWebAction({ rpc }, "web_logout_all", who);
  assertEquals([o?.status, o?.body, o?.bellTopics], [200, { ok: true, count: 2 }, ["b1", "b2"]]);
  assertEquals(calls[1], { fn: "asn_relay_web_logout_all", args: { p_user: USER } });
  assertEquals(await handleWebAction({ rpc }, "list", who), null);
  const bad = await handleWebAction({ rpc: () => Promise.resolve({ data: null, error: { message: "x" } }) }, "web_logout_all", who);
  assertEquals(bad?.status, 500);
});

Deno.test("memoVerify：只記成功的結果、過了時間就重驗", async () => {
  let n = 0, t = 0;
  const v = memoVerify((tok) => { n++; return Promise.resolve(tok === "good" ? { id: USER, email: null, name: null } : null); }, 3000, () => t);
  await v("good"); await v("good");
  assertEquals(n, 1);
  t = 3001; await v("good");
  assertEquals(n, 2);
  await v("bad"); await v("bad");
  assertEquals(n, 4, "失敗不記");
});

Deno.test("browserLabel：只取瀏覽器與系統名稱，不存完整 User-Agent", () => {
  assertEquals(browserLabel("Mozilla/5.0 (Windows NT 10.0; Win64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0"), "Edge（Windows）");
  assertEquals(browserLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605 Version/17.0 Safari/605.1.15"), "Safari（macOS）");
  assertEquals(browserLabel("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"), "Firefox（Linux）");
  assertEquals(browserLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17.0 Mobile Safari/604.1"), "Safari（iOS）");
  assertEquals(browserLabel("curl/8.0"), "瀏覽器");
  assertEquals(browserLabel(null), "瀏覽器");
  assert(!browserLabel("Mozilla/5.0 (Windows NT 10.0) Chrome/130.0.6723.92 Safari/537.36").includes("130"));
});

// ---- 守門：放行清單與實際分派的動作比對（仿 rpc_names_test.ts）----
const FUNCS = new URL("../", import.meta.url);
const indexSrc = Deno.readTextFileSync(new URL("relay/index.ts", FUNCS)).replace(/\r\n/g, "\n");
const roomsSrc = Deno.readTextFileSync(new URL("_shared/rooms.ts", FUNCS)).replace(/\r\n/g, "\n");
const stripLineComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");

/** index.ts 裡實際會分派的所有動作名：字面比對的、各模組匯出的動作集合、群組 room_ 開頭的 */
function dispatchedActions(): Set<string> {
  const all = new Set<string>();
  for (const s of [ACCOUNT_ACTIONS, ACCT_ACTIONS, ATTACH_ACTIONS, DEVICE_CODE_ACTIONS, DEVICE_PAIR_ACTIONS, GROUP_ACTIONS, LAUNCH_ACTIONS, PARTNER_OP_ACTIONS, PERM_REQ_ACTIONS,
    PUSH_ACTIONS, QUOTA_SHARE_ACTIONS, SECRET_ACTIONS, SITE_ACTIONS, TERM_REQ_ACTIONS, TERM_VIEW_ACTIONS, USAGE_ACTIONS, OWNER_ONLY_ACTIONS]) for (const a of s) all.add(a);
  for (const m of stripLineComments(indexSrc).matchAll(/action === "([a-z_]+)"/g)) all.add(m[1]);
  for (const m of stripLineComments(roomsSrc).matchAll(/action === "(room_[a-z_]+)"/g)) all.add(m[1]);
  for (const a of ["quota_read", "node_rotate_key"]) all.add(a); // 以常數比對的
  return all;
}

Deno.test("守門：index.ts 實際分派的每個動作，都要在網頁的「放行」或「禁止」清單明列（新動作漏列就紅）", () => {
  const all = dispatchedActions();
  assert(all.size > 120, "應該掃得到一百二十個以上的動作：" + all.size);
  const missing = [...all].filter((a) => !WEB_ALLOWED_ACTIONS.has(a) && !WEB_DENIED_ACTIONS.has(a));
  assertEquals(missing, [], "沒有明列放行或禁止：" + missing.join("、"));
});

Deno.test("守門：放行與禁止兩份清單不重疊；清單裡的動作名都真的存在（不留過期的名字）", () => {
  const both = [...WEB_ALLOWED_ACTIONS].filter((a) => WEB_DENIED_ACTIONS.has(a));
  assertEquals(both, []);
  const all = dispatchedActions();
  all.add("web_sessions_list"); all.add("web_logout_all");
  const ghost = [...WEB_ALLOWED_ACTIONS, ...WEB_DENIED_ACTIONS].filter((a) => !all.has(a));
  assertEquals(ghost, [], "清單裡有不存在的動作：" + ghost.join("、"));
});

Deno.test("守門：第 0 階段的放行清單只有讀取類與網頁自己的動作（不含寄信、決定、發節點、開視窗）", () => {
  const sensitive = [...ACCOUNT_ACTIONS, ...PERM_REQ_ACTIONS, ...TERM_REQ_ACTIONS, ...SECRET_ACTIONS, ...LAUNCH_ACTIONS, ...PARTNER_OP_ACTIONS, ...TERM_VIEW_ACTIONS, ...GROUP_ACTIONS,
    ...ACCT_ACTIONS, ...DEVICE_CODE_ACTIONS, ...DEVICE_PAIR_ACTIONS, ...QUOTA_SHARE_ACTIONS, ...PUSH_ACTIONS, "send", "register", "reissue", "invite", "node_rotate_key", "roster", "asn_presence"];
  assertEquals(sensitive.filter((a) => WEB_ALLOWED_ACTIONS.has(a)), []);
  assertEquals([...WEB_ALLOWED_ACTIONS].sort(), ["ack", "avatar", "chat_history", "inbox", "list", "partner_avatar", "read_sync", "web_logout_all", "web_sessions_list", "whoami"]);
});

// ---- index.ts 的接法（結構守門：順序錯了、少一道就紅）----
Deno.test("index.ts：網頁閘道在帳號動作、金鑰驗證之前；網頁憑證在網頁路線之外被擋；預檢在所有驗證之前", () => {
  const code = stripLineComments(indexSrc);
  const at = (s: string) => {
    const i = code.indexOf(s);
    assert(i >= 0, "找不到：" + s);
    return i;
  };
  assert(at("webPreflight(WEB_ORIGINS, req)") < at("gateWebRequest("));
  assert(at("gateWebRequest(") < at("ACCOUNT_ACTIONS.has(action)) {\n    if (req.method"), "帳號動作要在網頁閘道之後");
  assert(at("gateWebRequest(") < at('action === "register"'));
  assert(at("gateWebRequest(") < at("const key = web ? null"), "金鑰驗證在網頁閘道之後");
  assert(code.includes("const me = nodes[0]"), "之後的動作都以 me 為準");
  assert(at("webCredentialCheck(") < at('action === "register"'), "網頁憑證的擋下要在第一個動作分支之前");
  assert(code.includes("withWebCors(WEB_ORIGINS, req, await handle(req))"), "回應補跨來源許可標頭");
  assert(code.includes("sessionId: sessionIdOfToken(token, u.id)"), "驗憑證時一併取 session_id");
  assert(code.includes('"asn_relay_list", { p_tenant: me.tenant_id, ...(web ? { p_include_web: true } : {}) }'), "只有網頁才帶 p_include_web");
  assert(!code.includes("irori_relay_"));
});
