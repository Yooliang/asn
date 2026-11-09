import { assert, assertEquals } from "jsr:@std/assert@1";
import type { RpcFn } from "./account_me.ts";
import { findSentByClientId, parseClientId, sendWithClientId } from "./send_client_id.ts";

const CID = "0f8fad5b-d9cb-469f-a165-70867728950e";

Deno.test("parseClientId：沒帶＝null；合法 UUID 轉小寫；其餘一律格式不對", () => {
  assertEquals(parseClientId(undefined), { ok: true, id: null });
  assertEquals(parseClientId(null), { ok: true, id: null });
  assertEquals(parseClientId(CID.toUpperCase()), { ok: true, id: CID });
  for (const v of ["", "abc", CID + "x", 123, true, {}, [], "0f8fad5b-d9cb-469f-a165-70867728950"]) {
    assertEquals(parseClientId(v), { ok: false }, String(v));
  }
});

Deno.test("sendWithClientId：沒帶 client_id（舊客戶端）走原路徑，不碰新函式也不帶 p_client_id", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc: RpcFn = (fn, args) => { calls.push([fn, args]); return Promise.resolve({ data: { id: "m1" }, error: null }); };
  await sendWithClientId(rpc, null, { p_body: "x" });
  assertEquals(calls.map((c) => c[0]), ["asn_relay_send"]);
  assertEquals("p_client_id" in calls[0][1], false);
});

Deno.test("sendWithClientId：帶 client_id 走 asn_relay_send_idem 並帶 p_client_id；重複由資料庫回 duplicate", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc: RpcFn = (fn, args) => { calls.push([fn, args]); return Promise.resolve({ data: { id: "m1", duplicate: true }, error: null }); };
  const r = await sendWithClientId(rpc, CID, { p_body: "x", p_voice: true });
  assertEquals(calls.map((c) => c[0]), ["asn_relay_send_idem"]);
  assertEquals(calls[0][1].p_client_id, CID);
  assertEquals(calls[0][1].p_voice, true);
  assertEquals(r.data, { id: "m1", duplicate: true });
});

Deno.test("sendWithClientId：後台還沒套用（找不到函式）退回一般寄信；其他錯誤不重試", async () => {
  const calls: string[] = [];
  const old: RpcFn = (fn) => {
    calls.push(fn);
    return Promise.resolve(fn === "asn_relay_send_idem" ? { data: null, error: { code: "PGRST202", message: "x" } } : { data: { id: "m2" }, error: null });
  };
  assertEquals((await sendWithClientId(old, CID, { p_body: "x" })).data, { id: "m2" });
  assertEquals(calls, ["asn_relay_send_idem", "asn_relay_send"]);
  calls.length = 0;
  const boom: RpcFn = (fn) => { calls.push(fn); return Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } }); };
  assert((await sendWithClientId(boom, CID, { p_body: "x" })).error !== null);
  assertEquals(calls, ["asn_relay_send_idem"]);
});

Deno.test("findSentByClientId：查到回 id；沒有、函式不存在、查詢失敗都回 null", async () => {
  const hit: RpcFn = (_f, a) => Promise.resolve({ data: { id: "m9" }, error: a.p_client_id === CID ? null : "x" });
  assertEquals(await findSentByClientId(hit, "N1", CID), "m9");
  assertEquals(await findSentByClientId(() => Promise.resolve({ data: null, error: null }), "N1", CID), null);
  assertEquals(await findSentByClientId(() => Promise.resolve({ data: null, error: { code: "PGRST202" } }), "N1", CID), null);
  const origErr = console.error; console.error = () => {};
  try { assertEquals(await findSentByClientId(() => Promise.resolve({ data: null, error: { code: "XX000" } }), "N1", CID), null); } finally { console.error = origErr; }
});

Deno.test("relay/index.ts send：格式檢查與重複判斷在附件驗證之前；重複時不綁附件、不敲門鈴", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  const send = src.slice(src.indexOf('action === "send"'), src.indexOf("// 遠端開視窗"));
  const at = (s: string) => send.indexOf(s);
  assert(at("parseClientId(") > 0 && at("bad_client_id") > at("parseClientId("));
  assert(at("findSentByClientId(") > at("bad_client_id") && at("findSentByClientId(") < at("prepareAttachments"), "先認重複再處理附件");
  assert(at("duplicate === true") > at("sendWithClientId(") && at("duplicate === true") < at("bindAttachments"), "重複不綁附件");
});

Deno.test("SQL：新函式權限收回、search_path 空、索引只對 client_id 非空；不改既有寄信函式", async () => {
  const sql = (await Deno.readTextFile(new URL("../../migrations/20261111120000_send_client_id.sql", import.meta.url))).replace(/\r/g, "");
  const body = sql.replace(/^--.*$/gm, "");
  assert(body.includes("(from_node, client_id) where client_id is not null"));
  assertEquals((body.match(/security definer\s+set search_path to ''/g) ?? []).length, 2);
  for (const sig of ["asn_relay_send_idem(uuid, text, text, text, text, text, uuid, boolean, uuid, boolean, boolean)", "asn_relay_send_lookup(text, uuid)"]) {
    assert(body.includes(`revoke all on function public.${sig} from public, anon, authenticated;`), sig);
    assert(body.includes(`grant execute on function public.${sig} to service_role;`), sig);
  }
  assert(!/create or replace function public\.asn_relay_send(_core|_voice)?\(/.test(body));
});
