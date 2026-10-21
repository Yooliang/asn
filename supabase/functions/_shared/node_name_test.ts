import { assertEquals } from "jsr:@std/assert@1";
import { parseSelfName, SELF_NAME_MAX } from "./node_name.ts";

Deno.test("parseSelfName：去頭尾空白、1～40 字、不含控制字元、必須是字串", () => {
  assertEquals(parseSelfName("  小希  "), "小希");
  assertEquals(parseSelfName("H-ASN"), "H-ASN");
  assertEquals(parseSelfName(""), null);
  assertEquals(parseSelfName("   "), null);
  assertEquals(parseSelfName("字".repeat(SELF_NAME_MAX)), "字".repeat(SELF_NAME_MAX));
  assertEquals(parseSelfName("字".repeat(SELF_NAME_MAX + 1)), null);
  assertEquals(parseSelfName("a\nb"), null);
  assertEquals(parseSelfName("a\u0007b"), null);
  assertEquals(parseSelfName("a\u007fb"), null);
  assertEquals(parseSelfName(null), null);
  assertEquals(parseSelfName(123), null);
  assertEquals(parseSelfName({ name: "x" }), null);
});

Deno.test("relay/index.ts：set_name 動作排在金鑰驗證之後，節點代號取自金鑰（me.id），不收 body 的節點", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  const auth = src.indexOf("const me = nodes[0]");
  const act = src.indexOf('action === "set_name"');
  if (auth < 0 || act < auth) throw new Error("set_name 必須在金鑰驗證（const me）之後");
  const block = src.slice(act, src.indexOf('action === "leave"'));
  if (!block.includes("p_node: me.id") || /b\??\.(node|id)/.test(block)) throw new Error("set_name 只能改 me.id 這一列");
});
