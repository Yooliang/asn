// #1808 守門（第 13 組）：群組排回覆順位不能把離線的成員排進去（#1656/#1659）。
// 執行：SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno test -A supabase/functions/_shared/guard_1808_offline_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { type RoomMember, fallbackWake, wakeOrder, wokenAis } from "./rooms.ts";

// 「40珊宜」以數字開頭，固定順位字串排序排在「工作佩佩」前面，但已關機
const MEMBERS: RoomMember[] = [
  { key: "~owner", name: "啟良", kind: "owner" },
  { key: "w02~佩佩", name: "工作佩佩", label: "工作佩佩", kind: "window", online: true },
  { key: "n40~珊宜", name: "40珊宜", label: "40珊宜", kind: "window", online: false },
  { key: "aegis", name: "牧陽 Aegis", label: "牧陽 Aegis", kind: "claude", online: true },
];
const BOTH = { from: "~owner", trust: "owner", mentions: ["w02~佩佩", "n40~珊宜"] };

Deno.test("#1659 守門：離線的 AI 不佔回覆順位，在線的工作佩佩是第一順位、不延遲", () => {
  const w = wakeOrder(BOTH, MEMBERS, "w02~佩佩")!;
  assertEquals([w.rank, w.total, w.before], [1, 1, []]);
  // 對照：兩位都在線時 40珊宜 排前面，工作佩佩要等
  const allOn = MEMBERS.map((m) => ({ ...m, online: true }));
  assertEquals(wakeOrder(BOTH, allOn, "w02~佩佩")!.rank, 2);
});

Deno.test("#1656 守門：被點名的全是離線 AI 時退回叫醒在線的 AI，不會講完沒人回", () => {
  const only = { from: "~owner", trust: "owner", mentions: ["n40~珊宜"] };
  assertEquals(fallbackWake(only, MEMBERS), true);
  assertEquals(wokenAis(only, MEMBERS, "aegis")!.map((m) => m.key), ["w02~佩佩", "aegis"]);
  // 有在線的被點名者就不退回
  assertEquals(fallbackWake({ ...only, mentions: ["n40~珊宜", "aegis"] }, MEMBERS), false);
});

Deno.test("#1656 守門：沒有 online 欄位（舊後台）一律當在線，行為不變", () => {
  const old = MEMBERS.map(({ online: _o, ...m }) => m as RoomMember);
  assertEquals(wakeOrder(BOTH, old, "w02~佩佩"), { rank: 2, total: 2, before: ["40珊宜"] });
});
