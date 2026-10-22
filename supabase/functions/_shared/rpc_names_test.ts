// #14 R6 守門：Edge Function 的資料庫呼叫一律用新名 asn_relay_*，不得再出現舊名 irori_relay_*（註解說明除外）。
// 且程式裡用到的每個新名，都必須在改名 migration 的清單裡（拼錯或漏改名會紅）。
import { assert, assertEquals } from "jsr:@std/assert@1";

const dir = new URL("./", import.meta.url);
const index = new URL("../relay/index.ts", import.meta.url);
const migration = await Deno.readTextFile(new URL("../../migrations/20261023040000_asn_relay_rename.sql", import.meta.url));

// 去掉整行註解與行尾註解（程式碼裡沒有用 // 開頭的字串網址混在 rpc 名附近，足夠用）
export function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\s\/\/.*$/, ""))
    .join("\n");
}

async function sources(): Promise<{ name: string; code: string }[]> {
  const out = [{ name: "relay/index.ts", code: stripComments(await Deno.readTextFile(index)) }];
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && e.name.endsWith(".ts") && !e.name.endsWith("_test.ts")) {
      out.push({ name: `_shared/${e.name}`, code: stripComments(await Deno.readTextFile(new URL(e.name, dir))) });
    }
  }
  return out;
}

Deno.test("R6：_shared 與 relay/index.ts 的程式碼不得再出現舊名 irori_relay_", async () => {
  const bad = (await sources()).filter((s) => s.code.includes("irori_relay_")).map((s) => s.name);
  assertEquals(bad, [], "仍有舊名：" + bad.join("、"));
});

Deno.test("R6：程式碼用到的每個 asn_relay_ 名稱都在改名 migration 的清單裡", async () => {
  const names = new Set<string>();
  for (const s of await sources()) for (const m of s.code.matchAll(/asn_relay_\w+/g)) names.add(m[0]);
  assert(names.size > 20, "應該掃得到二十個以上的呼叫：" + names.size);
  const missing = [...names].filter((n) => !migration.includes(`'irori_relay_${n.slice("asn_relay_".length)}'`));
  assertEquals(missing, [], "migration 清單缺：" + missing.join("、"));
});
