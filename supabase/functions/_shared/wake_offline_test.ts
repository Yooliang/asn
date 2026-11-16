// 群組排回覆順位時先排除離線的成員（#1656）：離線的 AI 不佔順位（不會排第一讓在線的人白等），
// 其他人全離線時讀者自己仍是第一順位；沒有 online 欄位（舊後台、真人）一律當在線。
// 執行：SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno test -A supabase/functions/_shared/wake_offline_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleNodeRoomAction, type RoomDeps, type RoomMember, fallbackWake, silentCandidates, wakeInfoOf, wakeOrder, wokenAis, wokenOffline } from "./rooms.ts";

// 今晚的情形：「40珊宜」以數字開頭，固定順位字串排序排在「工作佩佩」前面，但它已經關機
const AIS: RoomMember[] = [
  { key: "~owner", name: "啟良", kind: "owner" },
  { key: "w02~佩佩", name: "工作佩佩", label: "工作佩佩", kind: "window", online: true },
  { key: "n40~珊宜", name: "40珊宜", label: "40珊宜", kind: "window", online: false },
  { key: "aegis", name: "牧陽 Aegis", label: "牧陽 Aegis", kind: "claude", online: true },
  { key: "~u:abc", name: "阿明", label: "阿明", kind: "human" },
];
const ALL_ON: RoomMember[] = AIS.map((m) => (m.online === false ? { ...m, online: true } : m));
const MSG = { from: "~owner", trust: "owner", mentions: [] as string[] };
const MENTION_BOTH = { from: "~owner", trust: "owner", mentions: ["w02~佩佩", "n40~珊宜"] };

Deno.test("離線的不排順位：點名工作佩佩和（已關機的）40珊宜，工作佩佩是第一順位、不延遲", () => {
  // 對照：兩位都在線時，40珊宜（字串排序在前）排第一，工作佩佩要等
  assertEquals(wakeOrder(MENTION_BOTH, ALL_ON, "w02~佩佩"), { rank: 2, total: 2, before: ["40珊宜"] });
  const w = wakeOrder(MENTION_BOTH, AIS, "w02~佩佩")!;
  assertEquals([w.rank, w.total, w.before], [1, 1, []]);
});

Deno.test("沒有點名（全員）：離線的不算在 total、不在 before；在線的照原本規則排", () => {
  const a = wakeOrder(MSG, AIS, "aegis")!, p = wakeOrder(MSG, AIS, "w02~佩佩")!;
  assertEquals([p.rank, p.total, p.before], [1, 2, []]);
  assertEquals([a.rank, a.total, a.before], [2, 2, ["工作佩佩"]]);
});

Deno.test("被點到的人全部離線：讀者自己仍是第一順位（集合不會變空、不出錯、不被略過）", () => {
  const msg = { from: "~owner", trust: "owner", mentions: ["w02~佩佩", "aegis", "n40~珊宜"] };
  const allOff = AIS.map((m) => (m.key === "~owner" || m.key === "~u:abc" ? m : { ...m, online: false }));
  for (const self of ["w02~佩佩", "aegis", "n40~珊宜"]) {
    const w = wakeOrder(msg, allOff, self)!;
    assertEquals([w.rank, w.total, w.before], [1, 1, []], self);
    assert(!w.hold);
    assertEquals(wokenAis(msg, allOff, self)!.map((m) => m.key), [self]);
  }
  // 點名的只有離線的 aegis：退回叫醒在線的 AI，讀者（正在讀＝在線）排第一，不會整則沒人回
  const fb = wakeOrder({ from: "~owner", trust: "owner", mentions: ["aegis"] }, allOff, "w02~佩佩")!;
  assertEquals([fb.rank, fb.total], [1, 1]);
});

Deno.test("沒有 online 欄位（舊後台）或真人：一律當在線，行為和以前一樣", () => {
  const old = AIS.map(({ online: _o, ...m }) => m as RoomMember);
  assertEquals(wakeOrder(MENTION_BOTH, old, "w02~佩佩"), { rank: 2, total: 2, before: ["40珊宜"] });
  assertEquals(wokenOffline(MENTION_BOTH, old, "w02~佩佩"), []);
  assertEquals(wokenAis(MSG, AIS, "w02~佩佩")!.some((m) => m.kind === "human"), false);
});

Deno.test("wake_info：離線的 AI 列在最後、標略過（rank 0、hold），不佔順位；沒有分數也沒有多餘欄位", () => {
  const info = wakeInfoOf(MENTION_BOTH, AIS, "w02~佩佩")!;
  assertEquals(info, [{ key: "w02~佩佩", rank: 1, hold: false }, { key: "n40~珊宜", rank: 0, hold: true }]);
  const all = wakeInfoOf(MSG, AIS, "w02~佩佩")!;
  assertEquals(all.map((e) => [e.key, e.rank, e.hold]), [["w02~佩佩", 1, false], ["aegis", 2, false], ["n40~珊宜", 0, true]]);
  // 全員在線時和以前完全一樣
  assertEquals(wakeInfoOf(MSG, ALL_ON, "w02~佩佩")!.map((e) => [e.key, e.rank, e.hold]), [["n40~珊宜", 1, false], ["w02~佩佩", 2, false], ["aegis", 3, false]]);
});

Deno.test("離線的人上線後讀到同一則：集合裡他自己一定在，若他是唯一被點名的就是第一順位（上線後照樣會回）", () => {
  const only = { from: "~owner", trust: "owner", mentions: ["n40~珊宜"] };
  assertEquals(wokenOffline(only, AIS, "w02~佩佩").map((m) => m.key), ["n40~珊宜"], "離線的被點名者只在叫醒結果裡標出來");
  const w = wakeOrder(only, AIS, "n40~珊宜")!;
  assertEquals([w.rank, w.total], [1, 1]);
});

Deno.test("AI 發的、沒點名的訊息：候選只含在線的 AI（離線的不送去打分、不佔名額）", () => {
  const c = silentCandidates({ from: "aegis" }, AIS);
  assertEquals(c.map((m) => m.key), ["w02~佩佩"]);
});

Deno.test("room_read：離線的 40珊宜 不再讓工作佩佩延遲；存下的 wake_info 把離線的標略過", async () => {
  const messages = [{ seq: 5, from: "~owner", trust: "owner", body: "佩佩幫我看", mentions: ["w02~佩佩", "n40~珊宜"] }];
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const handlers: Record<string, () => unknown> = {
    asn_relay_room_read: () => ({ key: "w02~佩佩", last_seq: 5, messages }),
    asn_relay_room_members: () => ({ key: "w02~佩佩", members: AIS }),
    asn_relay_room_wake_set: () => ({ set: true }),
  };
  const deps: RoomDeps = {
    rpc: (fn, args) => { calls.push({ fn, args }); const h = handlers[fn]; return Promise.resolve({ data: h ? h() : {}, error: null }); },
    ring: () => Promise.resolve(),
    rosterHas: () => Promise.resolve(true),
  };
  const r = await handleNodeRoomAction(deps, { id: "w02" }, "room_read", { room: "r1", since: "0" });
  assertEquals(r.status, 200);
  const m = r.body.messages[0];
  assertEquals([m.for_me, m.wake.rank, m.wake.total, m.wake.before], [true, 1, 1, []]);
  const set = calls.find((c) => c.fn === "asn_relay_room_wake_set")!;
  assertEquals(set.args.p_info, [{ key: "w02~佩佩", rank: 1, hold: false }, { key: "n40~珊宜", rank: 0, hold: true }]);
});

Deno.test("退回叫醒：真人點名的全是離線的 AI → 叫醒在線的 AI（發言者除外），照固定規則排，工作佩佩第一、牧陽第二", () => {
  const only = { from: "~owner", trust: "owner", mentions: ["n40~珊宜"] };
  assertEquals(fallbackWake(only, AIS), true);
  const p = wakeOrder(only, AIS, "w02~佩佩")!, a = wakeOrder(only, AIS, "aegis")!;
  assertEquals([p.rank, p.total, p.before], [1, 2, []]);
  assertEquals([a.rank, a.total, a.before], [2, 2, ["工作佩佩"]]);
  const self40 = wakeOrder(only, AIS, "n40~珊宜")!;
  assertEquals([self40.rank, self40.total], [1, 1], "被點名的人自己讀到＝他在線，照一般規則回（不被當成離線）");
  // wake_info：在線的排順位，被點名的離線者標略過
  assertEquals(wakeInfoOf(only, AIS, "w02~佩佩")!.map((e) => [e.key, e.rank, e.hold]), [["w02~佩佩", 1, false], ["aegis", 2, false], ["n40~珊宜", 0, true]]);
});

Deno.test("退回叫醒的邊界：有點名在線的 AI、有點名真人、AI 發的、開頭紀錄與系統訊息、跨租戶對不到的鍵、被點名的是讀者自己，都不退回", () => {
  const f = (m: { from: string; trust: string; mentions: string[]; is_seed?: boolean; from_kind?: string }, self = "w02~佩佩") => fallbackWake(m, AIS, self);
  assertEquals(f({ from: "~owner", trust: "owner", mentions: ["n40~珊宜", "aegis"] }), false, "還有在線的被點名者");
  assertEquals(f({ from: "~owner", trust: "owner", mentions: ["n40~珊宜", "~u:abc"] }), false, "點名了真人");
  assertEquals(f({ from: "aegis", trust: "member", mentions: ["n40~珊宜"], from_kind: "ai" }), false, "AI 發的不退回");
  assertEquals(f({ from: "~owner", trust: "owner", mentions: ["n40~珊宜"], is_seed: true }), false);
  assertEquals(f({ from: "~owner", trust: "owner", mentions: ["n40~珊宜"], from_kind: "system" }), false);
  assertEquals(f({ from: "~owner", trust: "owner", mentions: ["x:zzz"] }), false, "對不到成員");
  assertEquals(f({ from: "~owner", trust: "owner", mentions: [] }), false, "沒點名");
  assertEquals(f({ from: "~owner", trust: "owner", mentions: ["n40~珊宜"] }, "n40~珊宜"), false, "被點名的是讀者自己");
  assertEquals(wakeOrder({ from: "~owner", trust: "owner", mentions: ["n40~珊宜", "aegis"] }, AIS, "w02~佩佩"), null, "沒被叫醒的讀者照舊回 null");
});

Deno.test("room_read：被點名的 40珊宜 離線，沒被點名但在線的工作佩佩讀到這則：for_me 轉真、順位 1；人在線時不動", async () => {
  const mk = (members: RoomMember[]) => {
    const messages = [{ seq: 6, from: "~owner", trust: "owner", body: "珊宜看一下", mentions: ["n40~珊宜"] }];
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const handlers: Record<string, () => unknown> = {
      asn_relay_room_read: () => ({ key: "w02~佩佩", last_seq: 6, messages }),
      asn_relay_room_members: () => ({ key: "w02~佩佩", members }),
      asn_relay_room_wake_set: () => ({ set: true }),
    };
    const deps: RoomDeps = {
      rpc: (fn, args) => { calls.push({ fn, args }); const h = handlers[fn]; return Promise.resolve({ data: h ? h() : {}, error: null }); },
      ring: () => Promise.resolve(),
      rosterHas: () => Promise.resolve(true),
    };
    return { deps, calls };
  };
  const off = mk(AIS);
  const r = await handleNodeRoomAction(off.deps, { id: "w02" }, "room_read", { room: "r1", since: "0" });
  const m = r.body.messages[0];
  assertEquals([m.for_me, m.wake.rank, m.wake.total], [true, 1, 2]);
  assertEquals((off.calls.find((c) => c.fn === "asn_relay_room_wake_set")!.args.p_info as { key: string }[]).map((e) => e.key), ["w02~佩佩", "aegis", "n40~珊宜"]);
  const on = mk(ALL_ON);
  const r2 = await handleNodeRoomAction(on.deps, { id: "w02" }, "room_read", { room: "r1", since: "0" });
  assertEquals(r2.body.messages[0].for_me, false);
  assertEquals(r2.body.messages[0].wake, undefined);
});
