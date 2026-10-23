import { assertEquals } from "jsr:@std/assert@1";
import { type RpcFn, sendWithPerson, voiceArgs } from "./account_me.ts";

Deno.test("voiceArgs：只有布林 true 才帶 p_voice", () => {
  assertEquals(voiceArgs(true), { p_voice: true });
  for (const v of [false, undefined, null, "true", "yes", 1, 0, {}, []]) assertEquals(voiceArgs(v), {}, String(v));
});

Deno.test("sendWithPerson：p_voice＝true 走 asn_relay_send_voice；一般寄信完全不碰它也不帶 p_voice", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc: RpcFn = (fn, args) => { calls.push([fn, args]); return Promise.resolve({ data: { id: "m1" }, error: null }); };
  await sendWithPerson(rpc, { p_body: "x", p_voice: true });
  assertEquals(calls.map((c) => c[0]), ["asn_relay_send_voice"]);
  assertEquals(calls[0][1].p_voice, true);
  calls.length = 0;
  await sendWithPerson(rpc, { p_body: "x" });
  assertEquals(calls.map((c) => c[0]), ["asn_relay_send"]);
  assertEquals("p_voice" in calls[0][1], false);
});

Deno.test("sendWithPerson：後台還沒套用語音函式（找不到）→ 退回一般寄信，信照寄、不帶 p_voice；其他錯誤不重試", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const old: RpcFn = (fn, args) => {
    calls.push([fn, args]);
    return Promise.resolve(fn === "asn_relay_send_voice" ? { data: null, error: { code: "PGRST202", message: "x" } } : { data: { id: "m2" }, error: null });
  };
  assertEquals((await sendWithPerson(old, { p_body: "x", p_voice: true, p_as_person: true })).data, { id: "m2" });
  assertEquals(calls.map((c) => c[0]), ["asn_relay_send_voice", "asn_relay_send"]);
  assertEquals("p_voice" in calls[1][1], false);
  assertEquals(calls[1][1].p_as_person, true);

  calls.length = 0;
  const broken: RpcFn = (fn, args) => { calls.push([fn, args]); return Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } }); };
  assertEquals((await sendWithPerson(broken, { p_body: "x", p_voice: true })).error !== null, true);
  assertEquals(calls.map((c) => c[0]), ["asn_relay_send_voice"]);
});

Deno.test("relay 函式的 send 動作：用 voiceArgs 帶旗標、在資料庫呼叫之前", async () => {
  const s = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  assertEquals(s.includes("...voiceArgs(b.voice)"), true);
  assertEquals(s.indexOf("...voiceArgs(b.voice)") > s.indexOf("sendWithPerson(rpc, {"), true);
});
