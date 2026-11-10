// 橋的回信寄件匣存檔壞了（#1249）：relay 的 outbox_bad_notice 動作只帶節點（取自金鑰），不收任何用戶端參數。
import { assert, assertEquals } from "jsr:@std/assert@1";

const src = Deno.readTextFileSync(new URL("../relay/index.ts", import.meta.url)).replace(/\r\n/g, "\n");
const start = src.indexOf('if (action === "outbox_bad_notice" && req.method === "POST") {');
const code = start >= 0 ? src.slice(start, src.indexOf("\n  }\n", start)) : "";

Deno.test("outbox_bad_notice：POST 動作存在，只呼叫一支 RPC，參數只有節點", () => {
  assert(start >= 0, "找不到 outbox_bad_notice 動作");
  assertEquals((code.match(/db\.rpc\(/g) ?? []).length, 1);
  assert(code.includes('db.rpc("asn_relay_outbox_bad_notice", { p_node: me.id })'));
});

Deno.test("outbox_bad_notice：不讀請求內容、不碰 kind，錯誤碼與 mux_blind_notice 一致", () => {
  assert(!/req\.json|req\.text|body/.test(code), "不收任何參數");
  assert(!/\bkind\b/.test(code));
  assert(code.includes('json(403, { error: "forbidden" })'));
  assert(code.includes('json(400, { error: data.error })'));
  assert(code.includes('json(500, { error: "internal" })'));
  assert(code.includes('json(200, { ok: true, notify: data?.notify ?? "skipped" })'));
});
