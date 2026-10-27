import { assertEquals } from "jsr:@std/assert@1";
import { sanitizeNodePlatform } from "./node_platform.ts";

Deno.test("平台只收 linux／windows／macos，其餘當 null（不存任意字串）", () => {
  for (const p of ["linux", "windows", "macos"]) assertEquals(sanitizeNodePlatform({ platform: p }).platform, p);
  for (const p of ["Linux", "win32", "", "x".repeat(200), 3, null, undefined, {}]) assertEquals(sanitizeNodePlatform({ platform: p }).platform, null, String(p));
});

Deno.test("不開放的原因：純文字、去控制字元、最多 120 字；空白或不是字串就是 null", () => {
  assertEquals(sanitizeNodePlatform({ launch_closed_reason: "  這台是公司的伺服器\n不開放\u0007  " }).reason, "這台是公司的伺服器 不開放");
  assertEquals([...(sanitizeNodePlatform({ launch_closed_reason: "字".repeat(300) }).reason ?? "")].length, 120);
  for (const r of ["", "   ", "\n\t", 5, null, undefined]) assertEquals(sanitizeNodePlatform({ launch_closed_reason: r }).reason, null, String(r));
  assertEquals(sanitizeNodePlatform({}), { platform: null, reason: null }, "舊的機器橋什麼都不帶");
});
