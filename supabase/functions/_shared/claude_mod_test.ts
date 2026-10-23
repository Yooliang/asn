import { assert, assertEquals } from "jsr:@std/assert@1";
import { sanitizeClaudeMod } from "./claude_mod.ts";

Deno.test("sanitizeClaudeMod：合格的狀態收下，多餘欄位丟掉，空字串版本與原因當沒有", () => {
  assertEquals(sanitizeClaudeMod({ state: "installed", version: "0.4.2", x: 1 }), { state: "installed", version: "0.4.2", reason: null });
  assertEquals(sanitizeClaudeMod({ state: "failed", reason: "  安裝外掛失敗：網路\n不通 " }), { state: "failed", version: null, reason: "安裝外掛失敗：網路 不通" });
  assertEquals(sanitizeClaudeMod({ state: "checking", version: "", reason: "   " }), { state: "checking", version: null, reason: null });
  for (const s of ["installed", "removed", "no_claude", "failed", "update_failed", "checking"]) assert(sanitizeClaudeMod({ state: s }));
});

Deno.test("sanitizeClaudeMod：看不懂的整筆不收（回 null），原因截 120 字", () => {
  for (const bad of [null, undefined, 5, "installed", [], {}, { state: "weird" }, { state: 5 }, { state: "installed", version: "1 2" }, { state: "installed", version: 3 }, { state: "installed", version: "x".repeat(33) }, { state: "failed", reason: 5 }]) {
    assertEquals(sanitizeClaudeMod(bad), null, JSON.stringify(bad));
  }
  assertEquals(sanitizeClaudeMod({ state: "failed", reason: "字".repeat(300) })!.reason!.length, 120);
});

Deno.test("守門：relay 的 roster 動作在名單寫入之後才處理 mod，只呼叫 asn_relay_ 前綴函式、節點取自金鑰、失敗不擋名單", async () => {
  const src = (await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  const i = src.indexOf('if (action === "roster"');
  const blk = src.slice(i, src.indexOf("// 節點改自己的顯示名", i));
  assert(blk.includes('db.rpc("asn_relay_set_claude_mod", { p_node: me.id, p_mod: cm })'));
  assert(blk.indexOf("asn_relay_set_claude_mod") > blk.indexOf('db.rpc("asn_relay_roster"'), "名單先寫");
  const mod = blk.slice(blk.indexOf('if ("mod" in b)'), blk.indexOf("syncNodeAuto"));
  assert(!mod.includes("return json("), "外掛狀態失敗不擋名單");
  assert(!src.includes("irori_relay_set_claude_mod"));
});
