import { assertEquals } from "jsr:@std/assert@1";
import { handleDeviceReplace, handleDeviceReplaceCandidates, handleDeviceReplaceDismiss, parseDeviceReplace } from "./device_replace.ts";
import type { RpcFn } from "./partners.ts";

const UID = "11111111-1111-1111-1111-111111111111";
const okUser = () => Promise.resolve({ id: UID, email: "a@b.c", name: "甲" });
const noUser = () => Promise.resolve(null);
const SIGNED = "Bearer tok-1234567890abcdef";
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const e = console.error;
  console.error = () => {};
  try { return await f(); } finally { console.error = e; }
};

Deno.test("parseDeviceReplace：取代要 new 與 old 且不同；不取代只要 new；格式要合格", () => {
  assertEquals(parseDeviceReplace({ new: "n1", old: "o1", user: "evil" }, true), { new: "n1", old: "o1" });
  assertEquals(parseDeviceReplace({ new: "n1" }, false), { new: "n1", old: "" });
  for (const b of [null, "x", {}, { new: "n1" }, { new: "n1", old: "n1" }, { new: "a b", old: "o" }, { new: "n", old: "x".repeat(33) }, { new: 5, old: "o" }]) {
    assertEquals(parseDeviceReplace(b, true), null, JSON.stringify(b));
  }
});

Deno.test("取代：沒簽章 401、不打資料庫；送請求的節點取自金鑰（me），使用者取自簽章", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc: RpcFn = (fn, args) => { calls.push([fn, args]); return Promise.resolve({ data: { ok: true, already: false, renamed: true }, error: null }); };
  const b = { new: "n1", old: "o1" };
  assertEquals((await handleDeviceReplace({ rpc, verifyJwt: okUser }, { id: "H" }, null, b)).status, 401);
  assertEquals((await handleDeviceReplace({ rpc, verifyJwt: noUser }, { id: "H" }, SIGNED, b)).status, 401);
  assertEquals((await handleDeviceReplace({ rpc, verifyJwt: okUser }, { id: "H" }, SIGNED, { new: "n1" })).status, 400);
  assertEquals(calls.length, 0);
  const r = await handleDeviceReplace({ rpc, verifyJwt: okUser }, { id: "H" }, SIGNED, { ...b, actor: "evil", user: "evil" });
  assertEquals(r, { status: 200, body: { ok: true, already: false, renamed: true } });
  assertEquals(calls, [["asn_device_replace", { p_user: UID, p_actor: "H", p_new: "n1", p_old: "o1" }]]);
});

Deno.test("取代：資料庫的錯誤對應成狀態碼與白話；後台還沒套 migration 回 404；未知錯誤不外洩原文", async () => {
  const mk = (data: unknown, error: unknown = null): RpcFn => () => Promise.resolve({ data, error });
  const run = (rpc: RpcFn) => handleDeviceReplace({ rpc, verifyJwt: okUser }, { id: "H" }, SIGNED, { new: "n1", old: "o1" });
  assertEquals((await run(mk({ error: "not_found" }))).status, 404);
  assertEquals((await run(mk({ error: "not_candidate" }))).status, 409);
  assertEquals((await run(mk({ error: "answered" }))).status, 409);
  const r = await quiet(() => run(mk({ error: "weird_internal_code" })));
  assertEquals(r.status, 400);
  assertEquals(JSON.stringify(r.body).includes("weird_internal_code"), false);
  assertEquals((await run(mk({}))).status, 400);
  assertEquals((await run(mk(null, { code: "PGRST202" }))).status, 404);
  assertEquals((await quiet(() => run(mk(null, { code: "XX000" })))).status, 500);
});

Deno.test("不取代與候選：打對的函式、帶對的參數", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc: RpcFn = (fn, args) => { calls.push([fn, args]); return Promise.resolve({ data: fn.endsWith("candidates") ? { cards: [{ node: "n1" }] } : { ok: true }, error: null }); };
  assertEquals(await handleDeviceReplaceDismiss({ rpc, verifyJwt: okUser }, { id: "H" }, SIGNED, { new: "n1", old: "ignored" }), { status: 200, body: { ok: true } });
  assertEquals(await handleDeviceReplaceCandidates({ rpc, verifyJwt: okUser }, { id: "H" }, SIGNED), { status: 200, body: { cards: [{ node: "n1" }] } });
  assertEquals((await handleDeviceReplaceCandidates({ rpc, verifyJwt: okUser }, { id: "H" }, null)).status, 401);
  assertEquals(calls, [
    ["asn_device_replace_dismiss", { p_user: UID, p_actor: "H", p_new: "n1" }],
    ["asn_device_replace_candidates", { p_user: UID, p_actor: "H" }],
  ]);
});

Deno.test("relay/index.ts：三個 device_replace 動作都排在金鑰驗證之後、走本人簽章標頭、節點取自金鑰（me）", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  const auth = src.indexOf("const me = nodes[0]");
  for (const a of ["device_replace_candidates", "device_replace", "device_replace_dismiss"]) {
    const at = src.indexOf(`action === "${a}"`);
    if (auth < 0 || at < auth) throw new Error(`${a} 必須在金鑰驗證（const me）之後`);
    const block = src.slice(at, src.indexOf("return json(r.status", at));
    if (!block.includes("me,") || !block.includes("SIGN_HEADER")) throw new Error(`${a} 要用 me 與 SIGN_HEADER`);
  }
});
