import { assertEquals } from "jsr:@std/assert@1";
import { SIGN_HEADER, signedArgs, signedUserId } from "./owner_sign.ts";

const UID = "11111111-2222-3333-4444-555555555555";
const TOKEN = "a".repeat(40) + ".b.c";
const okVerify = (token: string) => Promise.resolve(token === TOKEN ? { id: UID, email: null, name: null } : null);

Deno.test("有效憑證：回使用者 id", async () => {
  assertEquals(await signedUserId(okVerify, `Bearer ${TOKEN}`), UID);
});

Deno.test("沒帶、格式不對、驗證不過：回 null（不擋寄送）", async () => {
  assertEquals(await signedUserId(okVerify, null), null);
  assertEquals(await signedUserId(okVerify, ""), null);
  assertEquals(await signedUserId(okVerify, TOKEN), null);
  assertEquals(await signedUserId(okVerify, "Bearer short"), null);
  assertEquals(await signedUserId(okVerify, `Bearer ${"z".repeat(40)}`), null);
});

Deno.test("驗證時丟錯或回不合格的 id：回 null", async () => {
  assertEquals(await signedUserId(() => Promise.reject(new Error("boom")), `Bearer ${TOKEN}`), null);
  assertEquals(await signedUserId(() => Promise.resolve({ id: "not-a-uuid", email: null, name: null }), `Bearer ${TOKEN}`), null);
});

Deno.test("signedArgs：有 id 才帶 p_signed_user", () => {
  assertEquals(signedArgs(UID), { p_signed_user: UID });
  assertEquals(signedArgs(null), {});
});

// index.ts 是 Deno.serve 入口、無法直接 import，這裡守「真的接上了」，並守「節點金鑰驗證仍在簽章之前」
Deno.test("relay 的 send 與 room_post 接上本人簽章，且在節點金鑰驗證之後", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  assertEquals(SIGN_HEADER, "x-asn-user");
  const keyAuth = src.indexOf('db.rpc("asn_relay_auth"');
  const sendAt = src.indexOf('action === "send" && req.method');
  const roomAt = src.indexOf('action?.startsWith("room_")');
  assertEquals(keyAuth > 0 && sendAt > keyAuth && roomAt > keyAuth, true);
  const send = src.slice(sendAt, src.indexOf("// 遠端開視窗"));
  assertEquals(send.includes("signedUserId(") && send.includes("...signedArgs("), true);
  assertEquals(send.indexOf("signedUserId(") < send.indexOf("sendWithPerson("), true);
  const room = src.slice(roomAt);
  // 群組第一期起，room_post／room_read／room_list 的簽章經 groups.ts 的 signedRpc 帶 p_signed_user（對照表含 asn_relay_room_post）
  assertEquals(room.includes("signedUserId(") && room.includes("signedRpc("), true);
  const groups = await Deno.readTextFile(new URL("./groups.ts", import.meta.url));
  assertEquals(/asn_relay_room_post: "asn_relay_room_post"/.test(groups) && groups.includes("p_signed_user: signed"), true);
});

Deno.test("簽章標頭只在 send／room_post／launch／launchers／partner_op／partner_ops／secret_pending／secret_reply／read_sync／群組動作（group_*）讀取；room_read／room_list 也帶（其他動作不碰）", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  assertEquals(src.split("signedUserId(").length - 1, 7); // send、room_post／room_read／room_list、遠端開視窗（launch／launchers）、管理夥伴視窗（partner_op／partner_ops）、遠端密碼確認（secret_pending／secret_reply）、已讀同步（read_sync）、真人群組動作（group_*）
  assertEquals(src.split("SIGN_HEADER").length - 1, 11); // 匯入一次、十處讀取（send、room_post／read／list、chat_history、partner_succeed、partner_list、launch／launchers、partner_op／partner_ops、secret_pending／secret_reply、read_sync、group_*）
});
