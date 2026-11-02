import { assert, assertEquals } from "jsr:@std/assert@1";
import { parseMisrouteNotice } from "./misroute_notice.ts";

Deno.test("parseMisrouteNotice：mail_id 是 uuid 或沒帶，其餘看不懂", () => {
  const id = "00000000-0000-0000-0000-00000000000A";
  assertEquals(parseMisrouteNotice({ mail_id: id, extra: "丟掉" }), { mailId: id.toLowerCase() });
  assertEquals(parseMisrouteNotice({}), { mailId: null });
  assertEquals(parseMisrouteNotice({ mail_id: null }), { mailId: null });
  for (const bad of [null, undefined, "x", [], 5, { mail_id: 5 }, { mail_id: "不是編號" }, { mail_id: id + "x" }]) assertEquals(parseMisrouteNotice(bad), null, String(bad));
});

Deno.test("守門：relay 的 misroute_notice 動作節點取自金鑰、只呼叫 asn_relay_ 函式、通知失敗只記 warn", async () => {
  const src = (await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  const i = src.indexOf('if (action === "misroute_notice"');
  assert(i >= 0);
  const blk = src.slice(i, src.indexOf("\n  }\n", i));
  assert(blk.includes('db.rpc("asn_relay_misroute_notice", { p_node: me.id, p_mail_id: p.mailId })'));
  assert(blk.includes("parseMisrouteNotice(") && blk.includes('console.warn("misroute_notice notify"'));
  assert(blk.includes("await ring(t)"));
});
