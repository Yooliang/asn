// #2353 R3：Edge 的統一型號規則對共用向量（relay/shared/test-vectors/model-id.json）逐筆答對；字元集在 Edge 只能有一份。
import { assert, assertEquals } from "jsr:@std/assert@1";
import { isValidModelId, MODEL_ID_PATTERN } from "./model_id.ts";

const V = JSON.parse(await Deno.readTextFile(new URL("../../../relay/shared/test-vectors/model-id.json", import.meta.url)));

Deno.test("#2353 MODEL_ID_PATTERN 與向量檔的 pattern 逐字相同", () => {
  assertEquals(MODEL_ID_PATTERN, V.pattern);
});

Deno.test("#2353 isValidModelId：向量 valid 全過、invalid 全擋", () => {
  for (const s of V.valid) assert(isValidModelId(s), `應合法：${JSON.stringify(s)}`);
  for (const s of V.invalid) assert(!isValidModelId(s), `應不合法：${JSON.stringify(s)}`);
  for (const x of [null, undefined, 5, {}, []]) assert(!isValidModelId(x));
});

Deno.test("#2353 Edge 內只有一份型號字元集（launch.ts 不得再寫第二份）", async () => {
  const dir = new URL("./", import.meta.url);
  const hits: string[] = [];
  for await (const f of Deno.readDir(dir)) {
    if (!f.isFile || !f.name.endsWith(".ts") || f.name.endsWith("_test.ts")) continue;
    const text = await Deno.readTextFile(new URL(f.name, dir));
    if (text.includes("A-Za-z0-9._:/@+")) hits.push(f.name);
  }
  assertEquals(hits, ["model_id.ts"]);
});
