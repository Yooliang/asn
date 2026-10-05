import { assertEquals } from "jsr:@std/assert@1";
import { expectsReplyArgs } from "./expects_reply.ts";

Deno.test("expects_reply：true／false 帶給資料庫函式；沒給或 null 就不帶（舊寄件工具照舊，信的欄位是 null）", () => {
  assertEquals(expectsReplyArgs(true), { p_expects_reply: true });
  assertEquals(expectsReplyArgs(false), { p_expects_reply: false });
  assertEquals(expectsReplyArgs(undefined), {});
  assertEquals(expectsReplyArgs(null), {});
});

Deno.test("expects_reply：型別不對（字串、數字、物件、陣列）一律 null＝呼叫端回 400，不當成 true／false 亂猜", () => {
  for (const v of ["true", "false", "yes", "", 0, 1, {}, [], [true]]) assertEquals(expectsReplyArgs(v), null, String(v));
});

// irori-relay/index.ts 是 Deno.serve 的入口、沒辦法直接 import 來測，這裡只守「寄信動作真的用了這個共用檢查」
Deno.test("irori-relay 的 send 動作：用 expectsReplyArgs 檢查、型別不對回 400 bad_expects_reply、帶進 irori_relay_send", async () => {
  const src = await Deno.readTextFile(new URL("../irori-relay/index.ts", import.meta.url));
  const send = src.slice(src.indexOf('action === "send"'), src.indexOf("// 遠端開視窗"));
  const at = (s: string) => send.indexOf(s);
  assertEquals(at("expectsReplyArgs(b.expects_reply)") > 0, true);
  assertEquals(at('json(400, { error: "bad_expects_reply" })') > at("expectsReplyArgs(b.expects_reply)"), true);
  assertEquals(at("...er") > 0 && at("...er") < at("irori_relay_send") + 400, true);
  assertEquals(at("irori_relay_send") > at('json(400, { error: "bad_expects_reply" })'), true, "型別檢查要在呼叫資料庫之前");
});
