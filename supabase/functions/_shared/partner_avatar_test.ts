// 夥伴頭像（partner_avatar.ts）：請求整理（只認 agent 與 avatar、格式與大小沿用設備頭像規則）與資料庫回覆的 HTTP 對應。
import { assertEquals } from "jsr:@std/assert@1";
import { parseSetPartnerAvatar, setReply } from "./partner_avatar.ts";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const WEBP = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAw";

Deno.test("合法的 png／webp 通過；null＝移除；多餘欄位（node、partner_id）不被採用", () => {
  assertEquals(parseSetPartnerAvatar({ agent: "小文", avatar: PNG }), { ok: true, agent: "小文", avatar: PNG });
  assertEquals(parseSetPartnerAvatar({ agent: "a", avatar: WEBP }), { ok: true, agent: "a", avatar: WEBP });
  assertEquals(parseSetPartnerAvatar({ agent: "a", avatar: null }), { ok: true, agent: "a", avatar: null });
  const r = parseSetPartnerAvatar({ agent: "a", avatar: PNG, node: "W", partner_id: "p_x" });
  assertEquals(r, { ok: true, agent: "a", avatar: PNG });   // 回傳只有 agent 與 avatar，指定節點的欄位沒有出路
});

Deno.test("沒帶 avatar、agent 不合法、body 不是物件：bad_request（不猜意思）", () => {
  for (const b of [null, undefined, "x", 5, [], {}, { agent: "a" }, { avatar: PNG }, { agent: "", avatar: PNG }, { agent: 5, avatar: PNG }, { agent: "x".repeat(101), avatar: PNG }, { agent: "a\nb", avatar: PNG }]) {
    assertEquals(parseSetPartnerAvatar(b), { ok: false, error: "bad_request" }, JSON.stringify(b));
  }
});

Deno.test("格式與大小：SVG、GIF、JPEG、非字串、檔頭不對、太大都擋下", () => {
  const bad = ["data:image/svg+xml;base64,PHN2Zz4=", "data:image/gif;base64,R0lGODlh", "data:image/jpeg;base64,/9j/4AAQ", "hello", 5, true, {}, "data:image/png;base64,####",
    "data:image/png;base64,UklGRiIAAABXRUJQ", "data:image/webp;base64,iVBORw0KGgoAAAANSUhEUg=="];
  for (const avatar of bad) assertEquals(parseSetPartnerAvatar({ agent: "a", avatar }), { ok: false, error: "bad_avatar_format" }, String(avatar).slice(0, 30));
  assertEquals(parseSetPartnerAvatar({ agent: "a", avatar: "data:image/png;base64," + "A".repeat(48000) }), { ok: false, error: "avatar_too_large" });
  assertEquals(parseSetPartnerAvatar({ agent: "a", avatar: "data:image/png;base64," + "iVBORw0KGgo" + "A".repeat(44000) }), { ok: false, error: "avatar_too_large" });
});

Deno.test("資料庫回覆對應：成功 200、找不到 404、頻率 429、格式 400（bad_avatar_format）、其他 400", () => {
  assertEquals(setReply({ partner_id: "p_1", avatar_updated_at: "t" }), { status: 200, body: { ok: true, partner_id: "p_1", avatar_updated_at: "t" } });
  assertEquals(setReply({ partner_id: "p_1", avatar_updated_at: null }).body.avatar_updated_at, null);
  assertEquals(setReply({ error: "not_found" }), { status: 404, body: { error: "partner_not_found" } });
  assertEquals(setReply({ error: "rate_limited" }), { status: 429, body: { error: "rate_limited" } });
  assertEquals(setReply({ error: "bad_avatar" }), { status: 400, body: { error: "bad_avatar_format" } });
  assertEquals(setReply({ error: "bad_request" }), { status: 400, body: { error: "bad_request" } });
  assertEquals(setReply({ error: "whatever" }), { status: 400, body: { error: "bad_request" } });
});

Deno.test("relay/index.ts 的 set_partner_avatar：節點取自金鑰（p_node: me.id）、夥伴名只取自 parseSetPartnerAvatar；partner_avatar 限同租戶", () => {
  const src = Deno.readTextFileSync(new URL("../relay/index.ts", import.meta.url)).replace(/\r\n/g, "\n");
  const i = src.indexOf('action === "set_partner_avatar"');
  const block = src.slice(i, src.indexOf('action === "partner_avatar"', i));
  if (i < 0) throw new Error("沒有 set_partner_avatar 動作");
  assertEquals(block.includes("p_node: me.id"), true);
  assertEquals(/\bb\.node\b|\bbody\.node\b|searchParams/.test(block), false, "不接受請求內容指定節點");
  assertEquals(block.includes("p_agent: p.agent"), true);
  const j = src.indexOf('action === "partner_avatar"');
  assertEquals(src.slice(j, j + 700).includes("p_tenant: me.tenant_id"), true);
});
