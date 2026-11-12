import { assertEquals } from "jsr:@std/assert@1";
import { handleDeviceRename, parseDeviceName, parseDeviceRename } from "./device_rename.ts";
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

Deno.test("parseDeviceName：去頭尾空白、1～40 字、和資料庫同一套規則（控制字元、零寬與雙向字元、像指紋的字樣）", () => {
  for (const ok of ["Oppo 手機", "  手機  ", "小良的 Pixel 8", "abc 1234", "a".repeat(40), "Facade Bedded", "30家用"]) {
    assertEquals(parseDeviceName(ok), ok.trim(), ok);
  }
  const z = String.fromCharCode(0x200b), rlo = String.fromCharCode(0x202e), bom = String.fromCharCode(0xfeff);
  for (const bad of [null, 5, "", "   ", "a".repeat(41), "a\nb", `a${z}b`, `a${rlo}b`, `${bom}x`, "Oppo（指紋 12d01662）", "指紋", "12d01662", "x DEAD1EEF", "81be 4164", "81be　4164"]) {
    assertEquals(parseDeviceName(bad), null, JSON.stringify(bad));
  }
});

Deno.test("parseDeviceRename：只收 node 與 name；node 格式要合格", () => {
  assertEquals(parseDeviceRename({ node: "w02", name: " 工作機 ", user: "evil", actor: "x" }), { node: "w02", name: "工作機" });
  for (const b of [null, "x", {}, { node: "w02" }, { name: "x" }, { node: "a b", name: "x" }, { node: "x".repeat(33), name: "x" }, { node: 5, name: "x" }]) {
    assertEquals(parseDeviceRename(b), null, JSON.stringify(b));
  }
});

Deno.test("handleDeviceRename：沒簽章 401、不打資料庫；送請求的節點取自金鑰（me），使用者取自簽章", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc: RpcFn = (fn, args) => { calls.push([fn, args]); return Promise.resolve({ data: { ok: true, name: "工作機", changed: true }, error: null }); };
  assertEquals((await handleDeviceRename({ rpc, verifyJwt: okUser }, { id: "H" }, null, { node: "w02", name: "工作機" })).status, 401);
  assertEquals((await handleDeviceRename({ rpc, verifyJwt: noUser }, { id: "H" }, SIGNED, { node: "w02", name: "工作機" })).status, 401);
  assertEquals((await handleDeviceRename({ rpc, verifyJwt: okUser }, { id: "H" }, SIGNED, { node: "w02", name: "" })).status, 400);
  assertEquals(calls.length, 0);
  const r = await handleDeviceRename({ rpc, verifyJwt: okUser }, { id: "H" }, SIGNED, { node: "w02", name: " 工作機 ", actor: "evil" });
  assertEquals(r, { status: 200, body: { ok: true, name: "工作機", changed: true } });
  assertEquals(calls, [["asn_device_rename", { p_user: UID, p_actor: "H", p_node: "w02", p_name: "工作機" }]]);
});

Deno.test("handleDeviceRename：資料庫的錯誤對應成狀態碼；後台還沒套 migration 回 404", async () => {
  const mk = (data: unknown, error: unknown = null): RpcFn => () => Promise.resolve({ data, error });
  const run = (rpc: RpcFn) => handleDeviceRename({ rpc, verifyJwt: okUser }, { id: "H" }, SIGNED, { node: "w02", name: "x" });
  assertEquals((await run(mk({ error: "not_found" }))).status, 404);
  assertEquals((await run(mk({ error: "rate_limited" }))).status, 429);
  assertEquals((await run(mk({ error: "bad_request" }))).status, 400);
  assertEquals((await run(mk({}))).status, 400);
  assertEquals((await run(mk(null, { code: "PGRST202" }))).status, 404);
  assertEquals((await quiet(() => run(mk(null, { code: "XX000" })))).status, 500);
  assertEquals((await run(mk({ ok: true, name: "x", changed: false }))).body, { ok: true, name: "x", changed: false });
});

Deno.test("relay/index.ts：device_rename 排在金鑰驗證之後、走本人簽章標頭、節點取自金鑰（me）", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  const auth = src.indexOf("const me = nodes[0]");
  const at = src.indexOf(`action === "device_rename"`);
  if (auth < 0 || at < auth) throw new Error("device_rename 必須在金鑰驗證（const me）之後");
  const block = src.slice(at, src.indexOf("return json(r.status", at));
  if (!block.includes("handleDeviceRename") || !block.includes("me,") || !block.includes("SIGN_HEADER")) throw new Error("device_rename 要用 me 與 SIGN_HEADER");
});
