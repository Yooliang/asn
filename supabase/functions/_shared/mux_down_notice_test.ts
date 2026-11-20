import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseMuxDownNotice } from "./mux_down_notice.ts";

Deno.test("只收夥伴數和有沒有接回，多的欄位丟掉", () => {
  assertEquals(parseMuxDownNotice({ count: 2, resumed: true }), { count: 2, resumed: true });
  assertEquals(parseMuxDownNotice({ count: 100, resumed: false, names: ["小乙"], body: "x" }), { count: 100, resumed: false });
  assertEquals(parseMuxDownNotice({ count: 1, resumed: false }), { count: 1, resumed: false });
  assertEquals(parseMuxDownNotice({ count: 0, resumed: false }), { count: 0, resumed: false }, "0＝服務裡沒有夥伴");
});

Deno.test("不合格的回 null", () => {
  const bad = [null, 1, "x", {}, { count: 2 }, { resumed: true }, { count: 101, resumed: true }, { count: -1, resumed: true }, { count: 1.5, resumed: true }, { count: "2", resumed: true }, { count: 2, resumed: "true" }, { count: 2, resumed: null }];
  for (const b of bad) assertEquals(parseMuxDownNotice(b), null);
});

import { parseMuxResumeNotice } from "./mux_down_notice.ts";

Deno.test("t1818 接回結果：人數對得上才收，名字是字串", () => {
  assertEquals(parseMuxResumeNotice({ count: 3, resumed: 2, failed: ["丙"] }), { count: 3, resumed: 2, failed: ["丙"] });
  assertEquals(parseMuxResumeNotice({ count: 2, resumed: 2, failed: [], reason: "x" }), { count: 2, resumed: 2, failed: [] });
});

Deno.test("t1818 接回結果：不合格的回 null", () => {
  const bad = [null, {}, { count: 0, resumed: 0, failed: [] }, { count: 2, resumed: 3, failed: [] }, { count: 3, resumed: 2, failed: [] }, { count: 2, resumed: 1, failed: [1] }, { count: 2, resumed: 1, failed: [""] }, { count: 2, resumed: 1, failed: ["x".repeat(65)] }, { count: 2, resumed: 1, failed: "丙" }, { count: 101, resumed: 100, failed: ["a"] }];
  for (const b of bad) assertEquals(parseMuxResumeNotice(b), null);
});
