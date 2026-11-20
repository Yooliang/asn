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

import { parseCompactNotice } from "./mux_down_notice.ts";

Deno.test("t1852 壓縮交接通知：合法的各種結果種類", () => {
  assertEquals(parseCompactNotice({ window: "小悠", count: 3, kind: "auto", pct: 62 }), { window: "小悠", count: 3, kind: "auto", reason: null, pct: 62 });
  assertEquals(parseCompactNotice({ window: "asn真", count: 3, kind: "remind_quota", reason: "5 小時", pct: 8 }), { window: "asn真", count: 3, kind: "remind_quota", reason: "5 小時", pct: 8 });
  assertEquals(parseCompactNotice({ window: "a", count: 100, kind: "remind_quota", reason: "每週", pct: null }), { window: "a", count: 100, kind: "remind_quota", reason: "每週", pct: null });
  assertEquals(parseCompactNotice({ window: "調查員", count: 4, kind: "remind_unknown" }), { window: "調查員", count: 4, kind: "remind_unknown", reason: null, pct: null });
  assertEquals(parseCompactNotice({ window: "小悠", count: 1, kind: "remind_off", pct: 0 }), { window: "小悠", count: 1, kind: "remind_off", reason: null, pct: 0 });
  assertEquals(parseCompactNotice({ window: " 小悠 ", count: 2, kind: "remind_failed" }), { window: "小悠", count: 2, kind: "remind_failed", reason: null, pct: null });
  assertEquals(parseCompactNotice({ window: "x".repeat(64), count: 2, kind: "auto" })?.window.length, 64);
});

Deno.test("t1852 壓縮交接通知：不合格的回 null", () => {
  const ok = { window: "小悠", count: 3, kind: "auto" };
  const bad: unknown[] = [
    null, 1, "x", [], {},
    { ...ok, kind: "other" }, { ...ok, kind: "" }, { ...ok, kind: 1 }, { window: "小悠", count: 3 },
    { ...ok, window: "" }, { ...ok, window: "   " }, { ...ok, window: "x".repeat(65) }, { ...ok, window: "a\nb" }, { ...ok, window: "a\u0000b" }, { ...ok, window: 5 },
    { ...ok, count: 0 }, { ...ok, count: 101 }, { ...ok, count: -1 }, { ...ok, count: 1.5 }, { ...ok, count: "3" },
    { ...ok, pct: -1 }, { ...ok, pct: 101 }, { ...ok, pct: 50.5 }, { ...ok, pct: "8" },
    { ...ok, kind: "remind_quota" }, { ...ok, kind: "remind_quota", reason: "每月" }, { ...ok, reason: "5 小時" },
    { ...ok, extra: "x" }, { ...ok, body: "hi" },
  ];
  for (const b of bad) assertEquals(parseCompactNotice(b), null, JSON.stringify(b));
});
