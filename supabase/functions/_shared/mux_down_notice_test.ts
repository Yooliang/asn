import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseMuxDownNotice } from "./mux_down_notice.ts";

Deno.test("只收夥伴數和有沒有接回，多的欄位丟掉", () => {
  assertEquals(parseMuxDownNotice({ count: 2, resumed: true }), { count: 2, resumed: true });
  assertEquals(parseMuxDownNotice({ count: 100, resumed: false, names: ["小乙"], body: "x" }), { count: 100, resumed: false });
  assertEquals(parseMuxDownNotice({ count: 1, resumed: false }), { count: 1, resumed: false });
});

Deno.test("不合格的回 null", () => {
  const bad = [null, 1, "x", {}, { count: 2 }, { resumed: true }, { count: 0, resumed: true }, { count: 101, resumed: true }, { count: -1, resumed: true }, { count: 1.5, resumed: true }, { count: "2", resumed: true }, { count: 2, resumed: "true" }, { count: 2, resumed: null }];
  for (const b of bad) assertEquals(parseMuxDownNotice(b), null);
});
