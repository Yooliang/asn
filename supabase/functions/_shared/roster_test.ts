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
  assertEquals(out[0], { name: "Gemini", status: "idle", cwd_label: "工作者", engine: "gemini", detail: null, context_pct: null, mod_loaded: null, kind: "window", receivable: true, model: null, hidden: null, active_at: null });
  assertEquals(out[1], { name: "H-Irori-2", status: "busy", cwd_label: null, engine: null, detail: null, context_pct: null, mod_loaded: null, kind: "window", receivable: true, model: null, hidden: null, active_at: null });
});

Deno.test("roster：detail 選填，字串才收、去頭尾空白、截 80 字；非字串或空白＝null（舊版機器橋沒帶也不壞）", () => {
  const out = normalizeRosterAgents([
    { name: "A", detail: "  背景工作 2 件  " },
    { name: "B", detail: "問".repeat(200) },
    { name: "C", detail: "   " },
    { name: "D", detail: 5 },
    { name: "E" },
  ]);
  assertEquals(out.map((a) => a.detail), ["背景工作 2 件", "問".repeat(80), null, null, null]);
});

Deno.test("roster：context_pct 選填，0～100 的數字才收（四捨五入）；其餘＝null", () => {
  const out = normalizeRosterAgents([
    { name: "A", context_pct: 85 },
    { name: "B", context_pct: 92.6 },
    { name: "C", context_pct: -1 },
    { name: "D", context_pct: 101 },
    { name: "E", context_pct: "80" },
    { name: "F" },
    { name: "G", context_pct: 0 },
  ]);
  assertEquals(out.map((a) => a.context_pct), [85, 93, null, null, null, null, 0]);
});

Deno.test("roster：kind／receivable／model 選填；舊版不帶＝window／true／null，壞值也當預設", () => {
  const out = normalizeRosterAgents([
    { name: "A", kind: "service", receivable: false, model: " claude-opus-4 " },
    { name: "B" },
    { name: "C", kind: "BAD KIND", receivable: "no", model: 5 },
    { name: "D", kind: 7, receivable: null, model: "   " },
    { name: "E", model: "m".repeat(200) },
  ]);
  assertEquals(out.map((a) => a.kind), ["service", "window", "window", "window", "window"]);
  assertEquals(out.map((a) => a.receivable), [false, true, true, true, true]);
  assertEquals(out.map((a) => a.model), ["claude-opus-4", null, null, null, "m".repeat(60)]);
});

Deno.test("roster：mod_loaded 選填，只收布林；其餘＝null", () => {
  const out = normalizeRosterAgents([{ name: "A", mod_loaded: true }, { name: "B", mod_loaded: false }, { name: "C", mod_loaded: "true" }, { name: "D", mod_loaded: 1 }, { name: "E" }]);
  assertEquals(out.map((a) => a.mod_loaded), [true, false, null, null, null]);
});

Deno.test("roster：hidden 選填，只收布林；舊版不帶或壞值＝null（前景／背景只代表視窗隱藏與否）", () => {
  const out = normalizeRosterAgents([{ name: "A", hidden: true }, { name: "B", hidden: false }, { name: "C" }, { name: "D", hidden: "yes" }, { name: "E", hidden: 1 }]);
  assertEquals(out.map((a) => a.hidden), [true, false, null, null, null]);
});

Deno.test("roster：active_at 選填（E2 #397），只收正整數毫秒；舊版不帶或壞值＝null", () => {
  const out = normalizeRosterAgents([{ name: "A", active_at: 1761631200000 }, { name: "B" }, { name: "C", active_at: "1761631200000" }, { name: "D", active_at: -5 }, { name: "E", active_at: 1.5 }, { name: "F", active_at: 1e300 }]);
  assertEquals(out.map((a) => a.active_at), [1761631200000, null, null, null, null, null]);
});
