// #2353 第②階段：電腦端（Rust）送出的 models wire 樣本，丟進真的 Edge 整理函式，一筆都不能被丟或改。
// 樣本與 Rust 測試共用 relay/shared/test-vectors/launcher-models-wire.json（Rust 端斷言序列化結果與它逐字相同）。
import { assertEquals } from "jsr:@std/assert@1";
import { sanitizeLauncher, sanitizeModels } from "./launch.ts";

const WIRE = JSON.parse(
  Deno.readTextFileSync(new URL("../../../relay/shared/test-vectors/launcher-models-wire.json", import.meta.url)),
);
const models = WIRE.models;

Deno.test("wire 樣本：真的 sanitizeModels 整理後與原值深度相等（Edge 一筆都不丟）", () => {
  assertEquals(models.length, 4);
  assertEquals(sanitizeModels(models), models);
});

Deno.test("wire 樣本：包進完整 launcher 經 sanitizeLauncher，launcher.models 與原值深度相等", () => {
  const out = sanitizeLauncher({ profiles: [{ id: "claude", label: "Claude" }], cwd_allow: ["C:/x"], models }) as Record<string, unknown>;
  assertEquals(out.models, models);
});
