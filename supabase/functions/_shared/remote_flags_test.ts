// 執行：SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno test -A supabase/functions/_shared/
import { assert, assertEquals } from "jsr:@std/assert@1";
import { sanitizeRemoteFlags } from "./remote_flags.ts";

Deno.test("收下布林：兩個都帶、只帶一個", () => {
  assertEquals(sanitizeRemoteFlags({ remote_view: true, remote_input: false }), { view: true, input: false });
  assertEquals(sanitizeRemoteFlags({ remote_view: false, remote_input: false }), { view: false, input: false });
  assertEquals(sanitizeRemoteFlags({ agents: [], remote_input: true }), { view: null, input: true });
  assertEquals(sanitizeRemoteFlags({ remote_view: false }), { view: false, input: null });
});

Deno.test("非布林一律丟掉（字串、數字、null、物件、陣列）；丟掉的欄位不會被當成 false", () => {
  for (const v of ["true", "false", "yes", 1, 0, null, {}, [], undefined]) {
    assertEquals(sanitizeRemoteFlags({ remote_view: v, remote_input: v }), null, String(v));
    assertEquals(sanitizeRemoteFlags({ remote_view: v, remote_input: true }), { view: null, input: true }, String(v));
  }
});

Deno.test("舊格式（沒帶這兩個欄位）、body 不是物件：回 null，什麼都不寫", () => {
  assertEquals(sanitizeRemoteFlags({ agents: [], platform: "windows" }), null);
  for (const b of [null, undefined, "x", 5, [], [{ remote_view: true }]]) assertEquals(sanitizeRemoteFlags(b), null);
});

Deno.test("relay/index.ts：roster 收兩個開關，節點取自金鑰（me.id）、不收 body 的節點；失敗只記 log，排在名單回成功之前", async () => {
  const src = (await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  const i = src.indexOf('db.rpc("asn_relay_set_remote_flags"');
  assert(i > 0, "roster 要呼叫 asn_relay_set_remote_flags");
  const call = src.slice(i, src.indexOf("\n", i));
  assert(call.includes("p_node: me.id") && !/\bb\??\.(node|id)\b/.test(call), call);
  assert(i > src.indexOf('action === "roster"') && i < src.indexOf('return json(200, { ok: true, count: data.count })'), "在 roster 動作裡、名單回成功之前");
  assert(src.includes("sanitizeRemoteFlags(b)"));
  const block = src.slice(src.indexOf("const rf = sanitizeRemoteFlags(b)"), i);
  assert(!block.includes("return json"), "這一段失敗不影響名單");
});
