import { assertEquals } from "jsr:@std/assert@1";
import { parseWindowRename, renamesFromRoster } from "./window_rename.ts";

Deno.test("parseWindowRename：去頭尾空白；舊名＝新名、空、含 ~、控制字元、過長、非字串都是 null", () => {
  assertEquals(parseWindowRename(" n33ae0d87 ", "asn-test-1"), { from: "n33ae0d87", to: "asn-test-1" });
  assertEquals(parseWindowRename("a", "a"), null);
  assertEquals(parseWindowRename("a", " a "), null);
  assertEquals(parseWindowRename("", "b"), null);
  assertEquals(parseWindowRename("a", "   "), null);
  assertEquals(parseWindowRename("a~b", "c"), null);
  assertEquals(parseWindowRename("a", "c\nd"), null);
  assertEquals(parseWindowRename("字".repeat(61), "c"), null);
  assertEquals(parseWindowRename("字".repeat(60), "c")?.from.length, 60);
  assertEquals(parseWindowRename(1, "c"), null);
  assertEquals(parseWindowRename(null, undefined), null);
});

Deno.test("renamesFromRoster：沒帶 renamed_from（舊版橋）＝沒有改名；壞值略過；重複只留一筆；最多 20 筆", () => {
  assertEquals(renamesFromRoster([{ name: "a" }, { name: "b", status: "idle" }]), []);
  assertEquals(renamesFromRoster([{ name: "新", renamed_from: "舊" }, { name: "新", renamed_from: "舊" }, { name: "x", renamed_from: "x" }, { name: "y", renamed_from: 5 }]), [{ from: "舊", to: "新" }]);
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `n${i}`, renamed_from: `o${i}` }));
  assertEquals(renamesFromRoster(many).length, 20);
});
