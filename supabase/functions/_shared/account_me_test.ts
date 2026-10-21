import { assertEquals } from "jsr:@std/assert@1";
import type { AuthUser } from "./account.ts";
import {
  bellTopicsOf, handleChatHistory, parseHistoryQuery, personArgs, type RpcFn, rpcMissing, sendWithPerson,
} from "./account_me.ts";

const UID = "11111111-1111-1111-1111-111111111111";
const user = (id = UID): AuthUser => ({ id, email: "a@b.c", name: "甲" });
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const o = console.error;
  console.error = () => {};
  try { return await f(); } finally { console.error = o; }
};

Deno.test("personArgs：只有 as_person 是布林 true 且有簽章才帶 p_as_person", () => {
  assertEquals(personArgs(true, UID), { p_as_person: true });
  for (const v of [false, undefined, null, "true", 1, {}, []]) assertEquals(personArgs(v, UID), {}, String(v));
  assertEquals(personArgs(true, null), {}, "沒簽章不能冒充人");
});

Deno.test("sendWithPerson：新版函式直接成功；舊版找不到九個參數的函式 → 退回不帶重呼叫；其他錯誤不重試", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const ok: RpcFn = (_fn, args) => { seen.push(args); return Promise.resolve({ data: { id: "m1" }, error: null }); };
  assertEquals((await sendWithPerson(ok, { p_body: "x", p_as_person: true })).data, { id: "m1" });
  assertEquals(seen.length, 1);

  seen.length = 0;
  const old: RpcFn = (_fn, args) => {
    seen.push(args);
    return Promise.resolve("p_as_person" in args ? { data: null, error: { code: "PGRST202", message: "x" } } : { data: { id: "m2" }, error: null });
  };
  assertEquals((await sendWithPerson(old, { p_body: "x", p_as_person: true })).data, { id: "m2" });
  assertEquals(seen.length, 2);
  assertEquals("p_as_person" in seen[1], false);
  assertEquals(seen[1].p_body, "x");

  seen.length = 0;
  const boom: RpcFn = (_fn, args) => { seen.push(args); return Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } }); };
  assertEquals((await sendWithPerson(boom, { p_body: "x", p_as_person: true })).error, { code: "XX000", message: "boom" });
  assertEquals(seen.length, 1);

  // 沒帶 p_as_person（舊用戶端）：函式找不到也不重試，錯誤照回
  seen.length = 0;
  const missing: RpcFn = (_fn, args) => { seen.push(args); return Promise.resolve({ data: null, error: { code: "PGRST202" } }); };
  assertEquals((await sendWithPerson(missing, { p_body: "x" })).error, { code: "PGRST202" });
  assertEquals(seen.length, 1);
});

Deno.test("rpcMissing：找不到函式的三種寫法", () => {
  assertEquals(rpcMissing({ code: "PGRST202" }), true);
  assertEquals(rpcMissing({ code: "42883" }), true);
  assertEquals(rpcMissing({ message: "Could not find the function public.x" }), true);
  assertEquals(rpcMissing({ code: "XX000", message: "boom" }), false);
  assertEquals(rpcMissing(null), false);
});

Deno.test("bellTopicsOf：扇出回多個門鈴（去重）；舊版只有一個；壞資料不丟例外", () => {
  assertEquals(bellTopicsOf({ bell_topic: "a", bell_topics: ["a", "b", "a"] }), ["a", "b"]);
  assertEquals(bellTopicsOf({ bell_topic: "a" }), ["a"]);
  assertEquals(bellTopicsOf({ bell_topics: [1, "", null, "c"] }), ["c"]);
  assertEquals(bellTopicsOf(null), []);
  assertEquals(bellTopicsOf({}), []);
});

Deno.test("parseHistoryQuery：夥伴節點必填且格式合格；視窗名可空；筆數上限 200", () => {
  assertEquals(parseHistoryQuery({ node: "M", agent: "小文" }), { node: "M", agent: "小文", limit: 100 });
  assertEquals(parseHistoryQuery({ node: "M" }), { node: "M", agent: null, limit: 100 });
  assertEquals(parseHistoryQuery({ node: "M", agent: "" }), { node: "M", agent: null, limit: 100 });
  assertEquals(parseHistoryQuery({ node: "M", limit: 9999 }), { node: "M", agent: null, limit: 200 });
  assertEquals(parseHistoryQuery({ node: "M", limit: 5 })?.limit, 5);
  for (const b of [null, "x", {}, { node: 5 }, { node: "a/b" }, { node: "" }, { node: "x".repeat(33) }, { node: "M", agent: 5 },
    { node: "M", agent: "a\nb" }, { node: "M", agent: "x".repeat(101) }, { node: "M", limit: 0 }, { node: "M", limit: 1.5 }, { node: "M", limit: "9" }]) {
    assertEquals(parseHistoryQuery(b), null, JSON.stringify(b));
  }
});

Deno.test("handleChatHistory：沒有有效簽章一律 401，不打資料庫（節點金鑰不夠）", async () => {
  let called = 0;
  const rpc: RpcFn = () => { called++; return Promise.resolve({ data: { messages: [] }, error: null }); };
  const mk = (verify: (t: string) => Promise<AuthUser | null>) => ({ rpc, verifyJwt: verify, withAttachments: (m: unknown) => Promise.resolve(m) });
  for (const h of [null, "", "Bearer", "Basic abc"]) {
    assertEquals((await handleChatHistory(mk(() => Promise.resolve(user())), { id: "H" }, h, { node: "M" })).status, 401, String(h));
  }
  assertEquals((await handleChatHistory(mk(() => Promise.resolve(null)), { id: "H" }, "Bearer tok-1234567890abcdef", { node: "M" })).status, 401);
  assertEquals((await quiet(() => handleChatHistory(mk(() => Promise.reject(new Error("x"))), { id: "H" }, "Bearer tok-1234567890abcdef", { node: "M" }))).status, 401);
  assertEquals((await handleChatHistory(mk(() => Promise.resolve(user())), { id: "H" }, "Bearer tok-1234567890abcdef", { node: "a/b" })).status, 400);
  assertEquals(called, 0);
});

// index.ts 是 Deno.serve 入口、無法直接 import，這裡守「真的接上了」
Deno.test("relay/index.ts：chat_history 在節點金鑰驗證之後且走本人簽章；send 只在有簽章時帶 as_person；扇出的門鈴逐一敲", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  const keyAuth = src.indexOf('db.rpc("irori_relay_auth"');
  const hist = src.indexOf('action === "chat_history"');
  assertEquals(keyAuth > 0 && hist > keyAuth, true);
  const h = src.slice(hist, src.indexOf('action === "leave"'));
  assertEquals(h.includes("handleChatHistory(") && h.includes("SIGN_HEADER") && h.includes("me,"), true);
  const send = src.slice(src.indexOf('action === "send" && req.method'), src.indexOf("// 遠端開視窗"));
  assertEquals(send.includes("...personArgs(b.as_person, signed)"), true);
  assertEquals(send.includes("for (const t of bellTopicsOf(sent)) await ring(t)"), true);
});

Deno.test("handleChatHistory：節點取自金鑰（me.id）、使用者取自簽章；附件資訊套在每則上；錯誤對應", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rows = [{ id: "u1", dir: "me", body: "嗨" }];
  const rpc: RpcFn = (fn, args) => { calls.push([fn, args]); return Promise.resolve({ data: { messages: rows }, error: null }); };
  const deps = (r: RpcFn) => ({
    rpc: r, verifyJwt: () => Promise.resolve(user()),
    withAttachments: (m: unknown) => Promise.resolve((m as unknown[]).map((x) => ({ ...(x as object), attachments: [] }))),
  });
  const r = await handleChatHistory(deps(rpc), { id: "H" }, "Bearer tok-1234567890abcdef", { node: "M", agent: "小文", p_user: "evil", user: "evil" });
  assertEquals(r.status, 200);
  assertEquals(r.body, { messages: [{ id: "u1", dir: "me", body: "嗨", attachments: [] }] });
  assertEquals(calls[0], ["asn_chat_history", { p_user: UID, p_node: "H", p_partner_node: "M", p_partner_agent: "小文", p_limit: 100 }]);

  const mkr = (data: unknown, error: unknown): RpcFn => () => Promise.resolve({ data, error });
  assertEquals((await handleChatHistory(deps(mkr({ error: "forbidden" }, null)), { id: "H" }, "Bearer tok-1234567890abcdef", { node: "M" })).status, 403);
  assertEquals((await handleChatHistory(deps(mkr({ error: "bad_request" }, null)), { id: "H" }, "Bearer tok-1234567890abcdef", { node: "M" })).status, 400);
  assertEquals((await handleChatHistory(deps(mkr(null, { code: "PGRST202" })), { id: "H" }, "Bearer tok-1234567890abcdef", { node: "M" })).status, 404);
  assertEquals((await quiet(() => handleChatHistory(deps(mkr(null, { code: "XX000" })), { id: "H" }, "Bearer tok-1234567890abcdef", { node: "M" }))).status, 500);
  assertEquals((await handleChatHistory(deps(mkr({}, null)), { id: "H" }, "Bearer tok-1234567890abcdef", { node: "M" })).body, { messages: [] });
});
