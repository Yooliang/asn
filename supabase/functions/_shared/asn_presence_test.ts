import { assert, assertEquals } from "jsr:@std/assert@1";
import { parseAsnPresence, PSM_MAX } from "./asn_presence.ts";

const ok = { window_name: "H-ASN", version: "0.1.13", status: "online" as const };

Deno.test("parseAsnPresence：合法內容；個人訊息可省略、空白當沒有、去頭尾空白", () => {
  assertEquals(parseAsnPresence(ok), { ...ok, psm: null, platform: null, foreground: null });
  assertEquals(parseAsnPresence({ ...ok, psm: "  聽歌中  " }), { ...ok, psm: "聽歌中", platform: null, foreground: null });
  assertEquals(parseAsnPresence({ ...ok, psm: "   " }), { ...ok, psm: null, platform: null, foreground: null });
  assertEquals(parseAsnPresence({ ...ok, psm: null, platform: null, foreground: null }), { ...ok, psm: null, platform: null, foreground: null });
  assertEquals(parseAsnPresence({ ...ok, window_name: "  小希  " })?.window_name, "小希");
});

Deno.test("parseAsnPresence：平台是選填；只收固定幾個值，其餘當沒帶（不拒絕整筆回報）", () => {
  for (const p of ["windows", "macos", "linux", "android", "ios"]) assertEquals(parseAsnPresence({ ...ok, platform: p })?.platform, p);
  for (const p of ["Android", "tablet", "", " android", null, 5, {}]) {
    const r = parseAsnPresence({ ...ok, platform: p });
    assertEquals(r?.platform, null, String(p));
    assertEquals(r?.version, ok.version, "其餘欄位照常");
  }
  assertEquals(parseAsnPresence(ok)?.platform, null);
});

Deno.test("parseAsnPresence：版本格式", () => {
  for (const v of ["0.1.13", "10.20.300", "1.2.3-beta.1"]) assertEquals(parseAsnPresence({ ...ok, version: v })?.version, v);
  for (const v of ["", "1", "1.2", "v1.2.3", "1.2.3.4", "1.2.x", "1.2.3-", "1.2.3 ", "12345.1.1", "1.2.3-a_b", "1.2.3\n", 123, null]) {
    assertEquals(parseAsnPresence({ ...ok, version: v }), null, String(v));
  }
});

Deno.test("parseAsnPresence：狀態白名單（offline 是關閉時的最後一次回報）", () => {
  for (const s of ["online", "away", "busy", "offline"]) assertEquals(parseAsnPresence({ ...ok, status: s })?.status, s);
  for (const s of ["Online", "idle", "", " online", null, 1]) assertEquals(parseAsnPresence({ ...ok, status: s }), null, String(s));
});

Deno.test("parseAsnPresence：長度與控制字元", () => {
  assertEquals(parseAsnPresence({ ...ok, window_name: "" }), null);
  assertEquals(parseAsnPresence({ ...ok, window_name: "字".repeat(41) }), null);
  assertEquals(parseAsnPresence({ ...ok, window_name: "a\nb" }), null);
  assertEquals(parseAsnPresence({ ...ok, psm: "字".repeat(PSM_MAX) })?.psm, "字".repeat(PSM_MAX));
  assertEquals(parseAsnPresence({ ...ok, psm: "字".repeat(PSM_MAX + 1) }), null);
  assertEquals(parseAsnPresence({ ...ok, psm: "a\u0007b" }), null);
  assertEquals(parseAsnPresence({ ...ok, psm: 5 }), null);
});

Deno.test("parseAsnPresence：不是物件一律拒絕；多出來的欄位（node）被丟掉", () => {
  for (const b of [null, undefined, "x", 1]) assertEquals(parseAsnPresence(b), null);
  assertEquals(Object.keys(parseAsnPresence({ ...ok, node: "別人" })!).sort(), ["foreground", "platform", "psm", "status", "version", "window_name"]);
});

Deno.test("relay/index.ts：presence 帶的平台只改金鑰所屬節點的 platform（用專用函式，不碰機器橋的 launch_closed_reason），且排在取走安裝請求之前", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  const set = src.indexOf('asn_relay_set_node_platform", { p_node: me.id, p_platform: p.platform }');
  const poll = src.indexOf('asn_relay_setup_poll"');
  assert(set > 0 && poll > set, "先記平台，再問有沒有安裝請求（手機才擋得住）");
});

Deno.test("relay/index.ts：asn_presence 動作排在金鑰驗證之後，節點代號取自金鑰（me.id），不收 body 的節點", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  const auth = src.indexOf("const me = nodes[0]");
  const act = src.indexOf('action === "asn_presence"');
  if (auth < 0 || act < auth) throw new Error("asn_presence 必須在金鑰驗證（const me）之後");
  const block = src.slice(act, src.indexOf('action === "leave"'));
  if (!block.includes("p_node: me.id") || /\bb\??\.(node|id)\b/.test(block)) throw new Error("asn_presence 只能寫 me.id 這一列");
});

Deno.test("parseAsnPresence：foreground 只收 true／false，其餘當沒帶（null，後台視同前景）", () => {
  assertEquals(parseAsnPresence({ ...ok, foreground: true })?.foreground, true);
  assertEquals(parseAsnPresence({ ...ok, foreground: false })?.foreground, false);
  for (const f of ["true", "false", 1, 0, null, {}, []]) {
    const r = parseAsnPresence({ ...ok, foreground: f });
    assertEquals(r?.foreground, null, String(f));
    assertEquals(r?.version, ok.version, "其餘欄位照常");
  }
  assertEquals(parseAsnPresence(ok)?.foreground, null);
});

Deno.test("relay asn_presence 動作：把 foreground 傳給資料庫函式（p_foreground）", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  assert(src.includes("p_foreground: p.foreground"), "要把解析後的 foreground 傳進 asn_relay_asn_presence_set");
});
