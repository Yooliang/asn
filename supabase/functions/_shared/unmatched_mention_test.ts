// #898：群組點名不在群組裡的夥伴。發言者要知道沒點到；這種訊息不能當成「沒點名的 AI 訊息」去叫醒別人。
import { assertEquals } from "jsr:@std/assert@1";
import { isSilentAiMsg, postMessage, type RoomDeps, type RoomMember, unmatchedMentions } from "./rooms.ts";

const MEMBERS: RoomMember[] = [
  { key: "~owner", name: "啟良", role: "owner", kind: "owner", node_role: "owner" },
  { key: "H~Gemini審查", name: "Gemini審查", kind: "window", node_role: "member", member_kind: "ai" },
  { key: "H~asn西川", name: "asn西川", kind: "window", node_role: "member", member_kind: "ai" },
  { key: "aegis", name: "牧陽 Aegis", kind: "claude", node_role: "member" },
];

Deno.test("unmatchedMentions：對不到成員的 @名字才回；對到的、email、沒有名字的都不算", () => {
  assertEquals(unmatchedMentions("@Test-Gemini（30家用） 請從 1 數到 60", MEMBERS), ["Test-Gemini（30家用）"]);
  assertEquals(unmatchedMentions("@Gemini審查 看一下", MEMBERS), []);
  assertEquals(unmatchedMentions("@牧陽 Aegis 總機", MEMBERS), [], "含空白的成員名照舊對得到");
  assertEquals(unmatchedMentions("寄到 a@b.com 就好", MEMBERS), [], "email 不算點名");
  assertEquals(unmatchedMentions("只有 @ 一個", MEMBERS), []);
  assertEquals(unmatchedMentions("@墊底夥伴，請看 @墊底夥伴。也請 @asn西川", MEMBERS), ["墊底夥伴"], "去掉結尾句讀、不重複；對到的不列");
  assertEquals(unmatchedMentions("（@不在的人） 你好", MEMBERS), ["不在的人）"], "全形括號前的 @ 也認");
});

Deno.test("isSilentAiMsg：AI 發言寫了 @名字 但對不到成員，不當成沒點名（不去叫醒別人）", () => {
  const ai = { from: "H~asn西川", from_kind: "ai", mentions: [] as string[] };
  assertEquals(isSilentAiMsg({ ...ai, body: "大家好，有人可以幫忙嗎" }, MEMBERS), true, "真的沒點名：照舊");
  assertEquals(isSilentAiMsg({ ...ai, body: "@Test-Gemini（30家用） 請從 1 數到 60" }, MEMBERS), false, "點了不在群組的名字：不叫醒別人");
  assertEquals(isSilentAiMsg({ ...ai, body: "寄到 a@b.com" }, MEMBERS), true, "email 不影響");
  assertEquals(isSilentAiMsg(ai, MEMBERS), true, "沒帶內文（舊呼叫端）照舊");
});

Deno.test("postMessage：回應帶 unmatched（只有內文裡打的名字）；都對到就不帶這個欄位", async () => {
  const mk = (): RoomDeps => ({
    rpc: async (fn: string) => {
      if (fn === "asn_relay_room_members") return { data: { members: MEMBERS }, error: null };
      if (fn === "asn_relay_room_post") return { data: { seq: 7, bell_topics: [] }, error: null };
      return { data: null, error: { message: "unexpected " + fn } };
    },
    ring: async () => {},
  } as unknown as RoomDeps);
  const r = await postMessage(mk(), { node: "H", agent: "asn西川" }, "r1", "@Test-Gemini（30家用） 請數數 @Gemini審查");
  assertEquals(r.status, 200);
  assertEquals((r.body as Record<string, unknown>).mentions, ["H~Gemini審查"]);
  assertEquals((r.body as Record<string, unknown>).unmatched, ["Test-Gemini（30家用）"]);
  const ok = await postMessage(mk(), { node: "H", agent: "asn西川" }, "r1", "@Gemini審查 看一下");
  assertEquals("unmatched" in (ok.body as Record<string, unknown>), false);
});
