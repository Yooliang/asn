// #2353 第②階段：電腦端（Rust）送出的 models wire 樣本，丟進真的 Edge 整理函式，一筆都不能被丟或改。
// 樣本與 Rust 測試共用 relay/shared/test-vectors/launcher-models-wire.json（Rust 端斷言序列化結果與它逐字相同）。
import { assertEquals } from "jsr:@std/assert@1";
import { MODELS_MAX_BYTES, sanitizeLauncher, sanitizeModels } from "./launch.ts";

const WIRE = JSON.parse(
  Deno.readTextFileSync(new URL("../../../relay/shared/test-vectors/launcher-models-wire.json", import.meta.url)),
);
const models = WIRE.models;

Deno.test("wire 樣本：真的 sanitizeModels 整理後與原值深度相等（Edge 一筆都不丟）", () => {
  assertEquals(models.length, 4);
  assertEquals(sanitizeModels(models), models);
});

// 最大量樣本（Rust 在八家、每家塞滿、id 100 字、顯示名 80 字，經回報上限後的真輸出）：一筆都不能被丟，也不能超過上限
const MAX = JSON.parse(
  Deno.readTextFileSync(new URL("../../../relay/shared/test-vectors/launcher-models-wire-max.json", import.meta.url)),
).models;

Deno.test("wire 最大量：真的 sanitizeModels 整理後與原值深度相等，一筆不丟，且緊湊 JSON 沒超過 24000 位元組", () => {
  assertEquals(MAX.length, 8);
  const total = MAX.reduce((n: number, e: { models: unknown[] }) => n + e.models.length, 0);
  assertEquals(total > 100, true);
  const bytes = new TextEncoder().encode(JSON.stringify(MAX)).length;
  assertEquals(bytes <= MODELS_MAX_BYTES && bytes > 23000, true, `bytes=${bytes}`);
  const out = sanitizeModels(MAX) as { models: unknown[] }[];
  assertEquals(out, MAX);
  assertEquals(out.reduce((n, e) => n + e.models.length, 0), total, "每一筆型號都在");
});

Deno.test("wire 最大量：包進完整 launcher 經 sanitizeLauncher，launcher.models 與原值深度相等（整份沒被丟）", () => {
  const out = sanitizeLauncher({ profiles: [{ id: "claude", label: "Claude" }], cwd_allow: ["C:/x"], models: MAX }) as Record<string, unknown>;
  assertEquals(out.models, MAX);
});

Deno.test("wire 樣本：包進完整 launcher 經 sanitizeLauncher，launcher.models 與原值深度相等", () => {
  const out = sanitizeLauncher({ profiles: [{ id: "claude", label: "Claude" }], cwd_allow: ["C:/x"], models }) as Record<string, unknown>;
  assertEquals(out.models, models);
});
