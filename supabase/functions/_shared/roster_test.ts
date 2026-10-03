import { assertEquals } from "jsr:@std/assert@1";
import { normalizeRosterAgents } from "./roster.ts";

Deno.test("roster：engine 合法就帶著，沒帶或格式不對＝null；多餘欄位丟掉", () => {
  const out = normalizeRosterAgents([
    { name: "Gemini", status: "idle", cwd_label: "工作者", engine: "gemini", pid: 123, secret: "x" },
    { name: "H-Irori-2", status: "busy" },
    { name: "A", engine: "Gemini" }, // 大寫不合格式
    { name: "B", engine: "x".repeat(21) }, // 太長
    { name: "C", engine: 5 },
    { name: "D", engine: "codex" },
  ]);
  assertEquals(out.map((a) => a.engine), ["gemini", null, null, null, null, "codex"]);
  assertEquals(out[0], { name: "Gemini", status: "idle", cwd_label: "工作者", engine: "gemini" });
  assertEquals(out[1], { name: "H-Irori-2", status: "busy", cwd_label: null, engine: null });
});
