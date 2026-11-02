import { assert, assertEquals } from "jsr:@std/assert@1";
import { sanitizeInboxHold } from "./inbox_hold.ts";

Deno.test("sanitizeInboxHold：毫秒時間轉 ISO，null 是清掉，看不懂的當沒帶", () => {
  assertEquals(sanitizeInboxHold(1_800_000_000_000), "2027-01-15T08:00:00.000Z");
  assertEquals(sanitizeInboxHold(null), null);
  for (const bad of [undefined, "1800000000000", 0, -5, NaN, Infinity, {}, [], true, 9e15]) assertEquals(sanitizeInboxHold(bad), undefined, String(bad));
});

Deno.test("守門：relay 的 roster 動作在名單寫入之後才處理 inbox_hold_until，只呼叫 asn_relay_ 前綴函式、節點取自金鑰、失敗不擋名單", async () => {
  const src = (await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  const i = src.indexOf('if (action === "roster"');
  const blk = src.slice(i, src.indexOf("// 節點改自己的顯示名", i));
  assert(blk.includes('db.rpc("asn_relay_set_inbox_hold", { p_node: me.id, p_until: hold })'));
  assert(blk.indexOf("asn_relay_set_inbox_hold") > blk.indexOf('db.rpc("asn_relay_roster"'), "名單先寫");
  const part = blk.slice(blk.indexOf('if ("inbox_hold_until" in b)'), blk.indexOf("syncNodeAuto"));
  assert(!part.includes("return json("), "收信暫停失敗不擋名單");
});
