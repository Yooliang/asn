import { assert, assertEquals } from "jsr:@std/assert@1";
import { MAX_EXCLUDE, parseExclude, readNodeInbox } from "./inbox_exclude.ts";

Deno.test("parseExclude：逗號分隔、去重、略過不合格；沒帶或全不合格＝null", () => {
  assertEquals(parseExclude("H-ASN,H-ASN舊名"), ["H-ASN", "H-ASN舊名"]);
  assertEquals(parseExclude("甲,甲,乙"), ["甲", "乙"]);
  assertEquals(parseExclude(",,"), null);
  assertEquals(parseExclude(""), null);
  assertEquals(parseExclude(null), null);
  assertEquals(parseExclude("甲, 乙"), ["甲"], "頭尾有空白的名字不合格");
  assertEquals(parseExclude("a\nb,乙"), ["乙"], "含控制字元略過");
  assertEquals(parseExclude("x".repeat(101)), null);
  const many = Array.from({ length: 80 }, (_, i) => `n${i}`).join(",");
  assertEquals(parseExclude(many)?.length, MAX_EXCLUDE);
});

Deno.test("readNodeInbox：沒帶 exclude 只傳 p_node（舊呼叫逐字不變）；帶了才多傳 p_exclude_agents", async () => {
  const calls: Record<string, unknown>[] = [];
  const rpc = (_fn: string, args: Record<string, unknown>) => {
    calls.push(args);
    return Promise.resolve({ data: [], error: null });
  };
  await readNodeInbox(rpc, "H", null);
  await readNodeInbox(rpc, "H", "");
  await readNodeInbox(rpc, "H", "H-ASN,舊名");
  assertEquals(calls, [{ p_node: "H" }, { p_node: "H" }, { p_node: "H", p_exclude_agents: ["H-ASN", "舊名"] }]);
});

Deno.test("readNodeInbox：migration 還沒套（帶參數呼叫出錯）時退回不帶參數的舊讀法", async () => {
  const calls: Record<string, unknown>[] = [];
  const rpc = (_fn: string, args: Record<string, unknown>) => {
    calls.push(args);
    return Promise.resolve("p_exclude_agents" in args ? { data: null, error: { message: "no function" } } : { data: [{ id: "1" }], error: null });
  };
  const r = await readNodeInbox(rpc, "H", "H-ASN");
  assertEquals(r.data, [{ id: "1" }]);
  assertEquals(calls.length, 2);
  assert(!("p_exclude_agents" in calls[1]));
});

Deno.test("relay/index.ts：沒帶 agent 的 inbox 走 readNodeInbox 並傳 exclude 參數；舊的直接呼叫已不存在", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  assert(src.includes('readNodeInbox((fn, args) => db.rpc(fn, args), me.id, url.searchParams.get("exclude"))'));
  assert(!src.includes('db.rpc("asn_relay_inbox", { p_node: me.id })'));
});

Deno.test("migration 20261023020000：舊的單參數版拿掉、新版選填、null 與沒指定收件人的信保留、只授權 service_role、其餘與上一版逐字相同", async () => {
  const sql = (await Deno.readTextFile(new URL("../../migrations/20261023020000_inbox_exclude_agents.sql", import.meta.url))).replace(/\r\n/g, "\n");
  assert(sql.includes("drop function if exists public.irori_relay_inbox(text);"));
  assert(sql.includes("create or replace function public.irori_relay_inbox(p_node text, p_exclude_agents text[] default null::text[])"));
  assert(sql.includes("(p_exclude_agents is null or m.to_agent is null or not (m.to_agent = any(p_exclude_agents)))"));
  assert(sql.includes("grant execute on function public.irori_relay_inbox(text, text[]) to service_role;"));
  assert(!/grant execute[^;]*to (anon|authenticated|public)/.test(sql));
  const prev = (await Deno.readTextFile(new URL("../../migrations/20261022090000_owner_sender_display.sql", import.meta.url))).replace(/\r\n/g, "\n");
  const body = (t: string, head: string) => t.slice(t.indexOf(head), t.indexOf("$function$;", t.indexOf(head)));
  const wherePrev = "    where m.to_node = p_node and m.acked_at is null\n";
  const a = body(prev, "create or replace function public.irori_relay_inbox(p_node text)").replace("(p_node text)\n", "\n").replace(wherePrev, "");
  const b = body(sql, "create or replace function public.irori_relay_inbox(p_node text, p_exclude_agents")
    .replace("(p_node text, p_exclude_agents text[] default null::text[])\n", "\n")
    .replace(wherePrev + "      and (p_exclude_agents is null or m.to_agent is null or not (m.to_agent = any(p_exclude_agents)))\n", "");
  assertEquals(b, a);
});
