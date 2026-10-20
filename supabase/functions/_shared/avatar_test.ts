import { assertEquals } from "jsr:@std/assert@1";
import { AVATAR_MAX_BYTES, AVATAR_MAX_CHARS, checkAvatar } from "./avatar.ts";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const WEBP = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAw";
const HEAD = "iVBORw0KGgoAAAANSUhEUg";
const mk = (bytes: number) => "data:image/png;base64," + HEAD + "A".repeat(Math.ceil(bytes / 3) * 4 - HEAD.length);

Deno.test("avatar：合法的 png／webp 通過；null＝移除", () => {
  assertEquals(checkAvatar(PNG), { ok: true, avatar: PNG });
  assertEquals(checkAvatar(WEBP), { ok: true, avatar: WEBP });
  assertEquals(checkAvatar(null), { ok: true, avatar: null });
});

Deno.test("avatar：格式不對一律 bad_avatar_format（svg、gif、jpeg、網址、腳本、沒帶、型別不對、壞 base64、檔頭冒充）", () => {
  for (
    const bad of [
      undefined, 5, {}, [], "", "data:image/png;base64,", "javascript:alert(1)", "https://x/a.png",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
      "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/", "data:image/png;base64,!!!!", "data:image/png;base64,iVBORw0K=GgoAAAA",
      "data:image/png;base64,/9j/4AAQSkZJRgABAQEASABIAAD/", "data:image/webp;base64,iVBORw0KGgoAAAANSUhEUg==",
    ]
  ) {
    assertEquals(checkAvatar(bad), { ok: false, error: "bad_avatar_format" }, String(bad));
  }
});

Deno.test("avatar：圖檔超過 32 KB 或全長超過 48000 字＝avatar_too_large；上限內通過", () => {
  assertEquals(checkAvatar(mk(AVATAR_MAX_BYTES - 2)).ok, true);
  assertEquals(checkAvatar(mk(AVATAR_MAX_BYTES + 1)), { ok: false, error: "avatar_too_large" });
  assertEquals(checkAvatar("data:image/png;base64," + HEAD + "A".repeat(AVATAR_MAX_CHARS)), { ok: false, error: "avatar_too_large" });
});

// irori-relay/index.ts 是 Deno.serve 的入口、沒辦法直接 import 來測，這裡守「動作真的用了共用檢查、只改自己節點、格式檢查在呼叫資料庫之前、list 不帶圖」
Deno.test("irori-relay：set_avatar 用 checkAvatar、只改金鑰所屬節點（me.id）；avatar 取圖限同租戶；list 沒有把圖本身塞進名單", async () => {
  const src = await Deno.readTextFile(new URL("../irori-relay/index.ts", import.meta.url));
  const set = src.slice(src.indexOf('action === "set_avatar"'), src.indexOf('action === "avatar"'));
  const at = (s: string) => set.indexOf(s);
  assertEquals(at("checkAvatar(b.avatar") > 0, true);
  assertEquals(at("irori_relay_set_avatar") > at("checkAvatar(b.avatar"), true, "格式檢查要在呼叫資料庫之前");
  assertEquals(at("p_node: me.id") > 0, true, "只能改自己節點");
  assertEquals(set.includes("b.node") || set.includes("b.id"), false, "不接受 body 指定別的節點");
  const get = src.slice(src.indexOf('action === "avatar"'), src.indexOf('action === "roster"'));
  assertEquals(get.includes("irori_relay_get_avatar") && get.includes("p_tenant: me.tenant_id") && get.includes("ID_RE.test"), true);
  const list = src.slice(src.indexOf('action === "list"'), src.indexOf('action === "set_avatar"'));
  assertEquals(list.includes("avatar:") || list.includes(".avatar"), false);
});

// SQL 與函式兩邊的上限、前綴與權限要一致
Deno.test("SQL 30：欄位、check 與兩個函式、只授權 service_role；上限與前綴跟 avatar.ts 一致；有回復檔", async () => {
  const sql = await Deno.readTextFile(new URL("../../sql/30_node_avatar.sql", import.meta.url));
  for (
    const k of [
      "add column if not exists avatar text", "avatar_updated_at timestamptz", "48000", "data:image/(png|webp);base64,",
      "irori_relay_set_avatar(p_node text, p_avatar text)", "irori_relay_get_avatar(p_tenant uuid, p_node text)",
      "'avatar_updated_at', case when n.avatar is null then null else n.avatar_updated_at end", "grant execute on function %s to service_role",
    ]
  ) assertEquals(sql.includes(k), true, k);
  assertEquals(AVATAR_MAX_CHARS, 48000);
  const down = await Deno.readTextFile(new URL("../../sql/rollback/30_node_avatar_down.sql", import.meta.url));
  assertEquals(down.includes("drop column if exists avatar;") && down.includes("drop function if exists public.irori_relay_set_avatar"), true);
});
