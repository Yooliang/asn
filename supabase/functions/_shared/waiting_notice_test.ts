import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseWaitingNotice } from "./waiting_notice.ts";

Deno.test("收視窗名、種類；選擇框才收內容", () => {
  assertEquals(parseWaitingNotice({ window: " 小乙 ", kind: "input", detail: "問題：要選哪一個？" }), { window: "小乙", kind: "input", detail: "問題：要選哪一個？", tool: null });
  assertEquals(parseWaitingNotice({ window: "小乙", kind: "other" }), { window: "小乙", kind: "other", detail: null, tool: null });
});

Deno.test("權限框只收工具名，內容丟掉", () => {
  assertEquals(parseWaitingNotice({ window: "小乙", kind: "permission", tool: "Bash", detail: "x" }), { window: "小乙", kind: "permission", detail: null, tool: "Bash" });
  assertEquals(parseWaitingNotice({ window: "小乙", kind: "permission", tool: "rm -rf /" })?.tool, null);
  assertEquals(parseWaitingNotice({ window: "小乙", kind: "input", tool: "Bash" })?.tool, null);
  assertEquals(parseWaitingNotice({ window: "小乙", kind: "permission", detail: "rm -rf /" }), { window: "小乙", kind: "permission", detail: null, tool: null });
  assertEquals(parseWaitingNotice({ window: "小乙", kind: "other", detail: "x" }), { window: "小乙", kind: "other", detail: null, tool: null });
});

Deno.test("控制字元拿掉，內容限長", () => {
  assertEquals(parseWaitingNotice({ window: "小\n乙", kind: "input", detail: "甲\n乙" }), { window: "小乙", kind: "input", detail: "甲 乙", tool: null });
  assertEquals([...(parseWaitingNotice({ window: "小乙", kind: "input", detail: "甲".repeat(700) })?.detail ?? "")].length, 600);
});

Deno.test("不合格的回 null", () => {
  for (const b of [null, 1, {}, { window: "", kind: "input" }, { window: "\n", kind: "input" }, { window: "乙".repeat(61), kind: "input" }, { window: "小乙", kind: "nope" }, { window: "小乙", kind: "input", detail: 1 }, { window: 1, kind: "input" }]) {
    assertEquals(parseWaitingNotice(b), null);
  }
});
