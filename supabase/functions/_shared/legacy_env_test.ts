import { assert, assertEquals } from "jsr:@std/assert@1";
import { applyLegacyEnv, LEGACY_ENV_MAX, LEGACY_ENV_NAMES, LEGACY_ENV_RE, sanitizeLegacyEnv } from "./legacy_env.ts";

const root = new URL("../../../", import.meta.url);
const read = (p: string) => Deno.readTextFile(new URL(p, root)).then((s) => s.replace(/\r\n/g, "\n"));

// 取出某個常數宣告到行首的「]」之間的內容（三個對照表都是單層陣列；Rust 結尾是「];」、JS 沒有分號）
function block(src: string, start: RegExp): string {
  const m = start.exec(src);
  assert(m, "找不到宣告：" + start);
  const rest = src.slice(m.index + m[0].length);
  const end = rest.search(/\n\s*\]/);
  assert(end > 0, "找不到結尾：" + start);
  return rest.slice(0, end).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
}

async function sourceUnion(): Promise<{ rust: string[]; machine: string[]; cloud: string[] }> {
  const rust = [...block(await read("relay/asn/src-tauri/src/envc.rs"), /pub const PAIRS[^=]*=\s*&\[/)
    .matchAll(/\(\s*"ASN_[A-Z0-9_]+"\s*,\s*"(IRORI_[A-Z0-9_]+)"\s*\)/g)].map((m) => m[1]);
  const machine = [...block(await read("relay/machine/env-compat.mjs"), /export const RENAMED\s*=\s*\[/)
    .matchAll(/'([A-Z0-9_]+)'/g)].map((m) => `IRORI_${m[1]}`);
  const cloud = [...block(await read("relay/cloud-agent/env-compat.mjs"), /export const ENV_RENAME_PAIRS\s*=\s*\[/)
    .matchAll(/\[\s*'ASN_[A-Z0-9_]+'\s*,\s*'(IRORI_[A-Z0-9_]+)'\s*\]/g)].map((m) => m[1]);
  return { rust, machine, cloud };
}

Deno.test("守門：舊名白名單＝三邊相容對照表（envc.rs PAIRS、machine RENAMED、cloud-agent ENV_RENAME_PAIRS）舊名的聯集", async () => {
  const { rust, machine, cloud } = await sourceUnion();
  assert(rust.length > 50, "電腦版對照表應該掃得到五十個以上：" + rust.length);
  assert(machine.length > 40, "機器橋對照表應該掃得到四十個以上：" + machine.length);
  assert(cloud.length > 20, "雲端代理對照表應該掃得到二十個以上：" + cloud.length);
  const union = [...new Set([...rust, ...machine, ...cloud])].sort();
  assertEquals([...LEGACY_ENV_NAMES], union, "legacy_env.ts 的白名單要跟三邊對照表的舊名聯集一致（新增改名時要一起補）");
  assert(LEGACY_ENV_NAMES.includes("IRORI_AEGIS_URL"), "Aegis 橋的舊名要在白名單裡");
});

Deno.test("白名單本身：每個都符合格式、已排序、沒有重複", () => {
  for (const n of LEGACY_ENV_NAMES) assert(LEGACY_ENV_RE.test(n), n);
  assertEquals([...LEGACY_ENV_NAMES], [...new Set(LEGACY_ENV_NAMES)].sort());
});

Deno.test("過濾：合格的留下，排序去重", () => {
  assertEquals(sanitizeLegacyEnv(["IRORI_RELAY_URL", "IRORI_AEGIS_URL", "IRORI_RELAY_ID", "IRORI_RELAY_URL"]), [
    "IRORI_AEGIS_URL",
    "IRORI_RELAY_ID",
    "IRORI_RELAY_URL",
  ]);
  assertEquals(sanitizeLegacyEnv([]), [], "空陣列＝回報了、沒用舊名");
});

Deno.test("過濾：格式不對、不在白名單、不是字串的一律丟掉", () => {
  const bad = [
    "irori_relay_url", // 小寫
    "ASN_RELAY_URL", // 新名
    "IRORI_", // 後面沒字
    "IRORI_NOT_A_REAL_NAME", // 格式對但不在白名單
    "IRORI_RELAY_URL=https://x", // 帶值
    " IRORI_RELAY_URL",
    "IRORI_" + "A".repeat(65),
    "PATH",
    "",
    5,
    null,
    undefined,
    { name: "IRORI_RELAY_URL" },
    ["IRORI_RELAY_URL"],
  ];
  assertEquals(sanitizeLegacyEnv(bad), []);
  assertEquals(sanitizeLegacyEnv([...bad, "IRORI_HOME"]), ["IRORI_HOME"]);
});

Deno.test("過濾：超過 64 個只留排序後的前 64 個", () => {
  assert(LEGACY_ENV_NAMES.length > LEGACY_ENV_MAX, "白名單比上限多，才測得到截斷");
  const all = [...LEGACY_ENV_NAMES].reverse();
  const r = sanitizeLegacyEnv([...all, ...all]);
  assertEquals(r?.length, LEGACY_ENV_MAX);
  assertEquals(r, [...LEGACY_ENV_NAMES].sort().slice(0, LEGACY_ENV_MAX));
});

Deno.test("過濾：欄位不是陣列就當沒帶（回 null，不寫）", () => {
  for (const v of ["IRORI_RELAY_URL", "", 0, 1, true, null, undefined, {}, { 0: "IRORI_RELAY_URL", length: 1 }]) {
    assertEquals(sanitizeLegacyEnv(v), null, String(v));
  }
});

type Call = { fn: string; args: Record<string, unknown> };
function fakeRpc(reply: { data?: unknown; error?: unknown } | Error = { data: { ok: true } }) {
  const calls: Call[] = [];
  const rpc = (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  return { calls, rpc };
}

Deno.test("名單分支：沒帶 used_legacy_env（舊版用戶端）就不呼叫寫入", async () => {
  const f = fakeRpc();
  await applyLegacyEnv(f.rpc, "n1", { agents: [] });
  assertEquals(f.calls, []);
});

Deno.test("名單分支：欄位不是陣列也不呼叫寫入", async () => {
  const f = fakeRpc();
  await applyLegacyEnv(f.rpc, "n1", { agents: [], used_legacy_env: "IRORI_RELAY_URL" });
  await applyLegacyEnv(f.rpc, "n1", { agents: [], used_legacy_env: null });
  assertEquals(f.calls, []);
});

Deno.test("名單分支：有帶就用節點代號寫入過濾後的清單（空陣列也寫）", async () => {
  const f = fakeRpc();
  await applyLegacyEnv(f.rpc, "n1", { agents: [], used_legacy_env: ["IRORI_RELAY_URL", "IRORI_FAKE", "IRORI_AEGIS_URL"] });
  await applyLegacyEnv(f.rpc, "n2", { agents: [], used_legacy_env: [] });
  assertEquals(f.calls, [
    { fn: "asn_relay_set_legacy_env", args: { p_node: "n1", p_names: ["IRORI_AEGIS_URL", "IRORI_RELAY_URL"] } },
    { fn: "asn_relay_set_legacy_env", args: { p_node: "n2", p_names: [] } },
  ]);
});

Deno.test("名單分支：資料庫還沒有這支函式、回錯誤或丟例外，都只記 log、不往外丟", async () => {
  for (
    const reply of [
      { error: { message: "Could not find the function public.asn_relay_set_legacy_env" } },
      { data: { error: "forbidden" } },
      new Error("連線中斷"),
    ]
  ) {
    const f = fakeRpc(reply);
    const logs: unknown[][] = [];
    await applyLegacyEnv(f.rpc, "n1", { used_legacy_env: ["IRORI_HOME"] }, (...a) => logs.push(a));
    assertEquals(f.calls.length, 1);
    assertEquals(logs.length, 1);
    assertEquals(logs[0][0], "set_legacy_env");
  }
});
