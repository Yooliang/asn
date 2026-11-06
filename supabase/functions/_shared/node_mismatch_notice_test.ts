import { assertEquals } from "jsr:@std/assert@1";
import { parseNodeMismatchNotice } from "./node_mismatch_notice.ts";

Deno.test("node_mismatch_notice：只收合格的節點代號，其餘一律不收", () => {
  assertEquals(parseNodeMismatchNotice({ configured: "t5-abcd1234" }), { configured: "t5-abcd1234" });
  assertEquals(parseNodeMismatchNotice({ configured: "g1", body: "自己寫的字" }), { configured: "g1" });
  for (const bad of [null, [], "g1", {}, { configured: "" }, { configured: 5 }, { configured: "a b" }, { configured: "<b>" }, { configured: "x".repeat(33) }]) {
    assertEquals(parseNodeMismatchNotice(bad), null, JSON.stringify(bad));
  }
});
