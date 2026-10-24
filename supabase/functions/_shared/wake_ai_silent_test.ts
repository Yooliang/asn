// AI 沒 @ 任何人的訊息也交給 Jev 判斷叫醒（#230）：過門檻者被叫醒並有順位、低分者略過；任何失敗誰都不叫醒；
// 達輪數上限不打 Jev；不套用保底；已有 @ 點名的 AI 訊息維持原行為；同一則訊息以第一次存下的 wake_info 為準。
// 執行：SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno test -A supabase/functions/_shared/wake_ai_silent_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleNodeRoomAction, type RoomDeps, type RoomMember } from "./rooms.ts";
import { rankFromEnv } from "./wake_rank.ts";

const MEMBERS: RoomMember[] = [
  { key: "~owner", name: "啟良", kind: "owner" },
  { key: "w02", name: "W02", label: "W02（啟良）", kind: "claude" },
  { key: "aegis", name: "牧陽 Aegis", label: "牧陽 Aegis（啟良）", kind: "claude" },
  { key: "H~H-主線", name: "H-主線", label: "H-主線（啟良）", kind: "window" },
  { key: "~u:abc", name: "阿明", label: "阿明", kind: "human" },
];
// 候選（不含發言者 aegis、不含真人）依標示排序：H-主線、W02
const aiMsg = (extra: Record<string, unknown> = {}) => ({ seq: 5, from: "aegis", from_kind: "ai", trust: "member", body: "我整理好了，誰來接？", mentions: [] as string[], ...extra });

type Opts = { messages?: unknown[]; chain?: unknown; chainError?: boolean; wakeSet?: "ok" | "error" | "legacy" };
function fake(o: Opts = {}, reader = "w02") {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const stored: Record<number, unknown> = {};
  const deps: RoomDeps = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      if (fn === "asn_relay_room_read") return Promise.resolve({ data: { key: reader, last_seq: 5, messages: o.messages ?? [aiMsg()] }, error: null });
      if (fn === "asn_relay_room_members") return Promise.resolve({ data: { key: reader, members: MEMBERS }, error: null });
      if (fn === "asn_relay_room_ai_chain") return Promise.resolve(o.chainError ? { data: null, error: "no function" } : { data: o.chain ?? { count: 0, limit: 5 }, error: null });
      if (fn === "asn_relay_room_wake_set") {
        if (o.wakeSet === "error") return Promise.resolve({ data: null, error: "boom" });
        if (o.wakeSet === "legacy") return Promise.resolve({ data: { set: true }, error: null });
        const info = args.p_info as { key: string; rank: number; hold: boolean; lim?: boolean }[];
        // 模擬資料庫：先到先得，回傳存下的版本（讀者視角）
        const seq = args.p_seq as number;
        const first = !(seq in stored);
        if (first) stored[seq] = info.map((e) => ({ key: e.key, label: e.key, rank: e.rank, hold: e.hold, ...(e.lim ? { limited: true } : {}) }));
        return Promise.resolve({ data: { set: first, wake_info: stored[seq] }, error: null });
      }
      return Promise.resolve({ data: {}, error: null });
    },
    ring: () => Promise.resolve(),
    rosterHas: () => Promise.resolve(true),
  };
  return { deps, calls };
}
const env = (k: string) => ({ JEV_RANK_ENABLED: "1", JEV_URL: "https://jev.example/x", JEV_KEY: "K" } as Record<string, string>)[k];
function jev(scores: number[] | "fail") {
  let n = 0;
  const f = ((_u: string, _i: RequestInit) => {
    n++;
    if (scores === "fail") return Promise.reject(new Error("net"));
    return Promise.resolve(new Response(JSON.stringify({ answers: Object.fromEntries(scores.map((s, i) => [`c${i}`, { type: "noul", noul: s }])) })));
  }) as unknown as typeof fetch;
  return { rank: rankFromEnv(env, f), count: () => n };
}
const read = (deps: RoomDeps, me = "w02") => handleNodeRoomAction(deps, { id: me }, "room_read", { room: "r1", since: "0" });
type SetCall = { args: { p_info: { key: string; rank: number; hold: boolean; lim?: boolean; fb?: boolean }[]; p_seq: number } };
const setCalls = (calls: { fn: string }[]) => calls.filter((c) => c.fn === "asn_relay_room_wake_set") as unknown as SetCall[];

Deno.test("AI 無 @：過門檻者被叫醒並有順位、低分者 hold 且不叫醒；候選不含發言者與真人", async () => {
  // 候選 H-主線 0.9、W02 0.2；讀者 H-主線
  const f = fake({}, "H~H-主線");
  f.deps.rank = jev([0.9, 0.2]).rank;
  const r = await read(f.deps, "H~H-主線");
  const m = r.body.messages[0];
  assertEquals([m.for_me, m.wake.rank, m.wake.total, m.wake.before], [true, 1, 1, []]);
  const sets = setCalls(f.calls);
  assertEquals(sets.length, 1);
  assertEquals(sets[0].args.p_info.map((e) => [e.key, e.rank, e.hold]), [["H~H-主線", 1, false], ["w02", 0, true]]);
  // 略過者讀同一則：for_me 必為 false 且沒有 wake（舊橋看到 for_me 為真會立刻回覆）
  const g = fake({}, "w02");
  g.deps.rank = jev([0.9, 0.2]).rank;
  const r2 = await read(g.deps, "w02");
  assertEquals([r2.body.messages[0].for_me, r2.body.messages[0].wake], [false, undefined]);
});

Deno.test("AI 無 @：兩位都過門檻 → 分數高的第一順位，total 只算通過者", async () => {
  const f = fake();
  f.deps.rank = jev([0.7, 0.9]).rank; // H-主線 0.7、W02 0.9
  const m = (await read(f.deps, "w02")).body.messages[0];
  assertEquals([m.for_me, m.wake.rank, m.wake.total, m.wake.before.length], [true, 1, 2, 0]);
  const g = fake({}, "H~H-主線");
  g.deps.rank = jev([0.7, 0.9]).rank;
  const h = (await read(g.deps, "H~H-主線")).body.messages[0];
  assertEquals([h.for_me, h.wake.rank, h.wake.total, h.wake.before.length], [true, 2, 2, 1]);
});

Deno.test("AI 無 @：Jev 失敗／逾時／未設定／格式不對，誰都不叫醒，也不退回固定順位", async () => {
  const unset = () => rankFromEnv((k) => (k === "JEV_RANK_ENABLED" ? "1" : undefined), (() => Promise.reject(new Error("x"))) as unknown as typeof fetch);
  for (const mk of [() => jev("fail").rank, () => null, unset, () => jev([0.9]).rank]) {
    const f = fake();
    f.deps.rank = mk();
    const r = await read(f.deps);
    assertEquals([r.body.messages[0].for_me, r.body.messages[0].wake], [false, undefined]);
    assertEquals(setCalls(f.calls).length, 0, "失敗不存，之後仍可重算");
  }
});

Deno.test("AI 無 @：全員低分也不套用保底；對照真人訊息同樣全員低分有保底", async () => {
  const f = fake();
  f.deps.rank = jev([0.1, 0.2]).rank;
  const r = await read(f.deps);
  assertEquals(r.body.messages[0].for_me, false);
  assertEquals(setCalls(f.calls)[0].args.p_info.map((e) => [e.rank, e.hold, e.fb]), [[0, true, undefined], [0, true, undefined]]);
  const f2 = fake({ messages: [{ seq: 5, from: "~owner", from_kind: "human", trust: "owner", body: "大家", mentions: [] }] });
  f2.deps.rank = jev([0.1, 0.2, 0.3]).rank;
  assertEquals((await read(f2.deps)).body.messages[0].for_me, true);
});

Deno.test("AI 無 @：達輪數上限（含上限 0）不打 Jev、無人叫醒，wake_info 全部略過並標明輪數上限；未達上限則照常", async () => {
  for (const chain of [{ count: 5, limit: 5 }, { count: 7, limit: 5 }, { count: 0, limit: 0 }]) {
    const j = jev([0.9, 0.9]);
    const f = fake({ chain });
    f.deps.rank = j.rank;
    const r = await read(f.deps);
    assertEquals(r.body.messages[0].for_me, false);
    assertEquals(j.count(), 0, "不打 Jev");
    assertEquals(setCalls(f.calls)[0].args.p_info.map((e) => [e.hold, e.rank, e.lim]), [[true, 0, true], [true, 0, true]]);
    assertEquals(f.calls.find((c) => c.fn === "asn_relay_room_ai_chain")!.args.p_seq, 5);
  }
  const f = fake({ chain: { count: 4, limit: 5 } });
  f.deps.rank = jev([0.9, 0.9]).rank;
  assertEquals((await read(f.deps)).body.messages[0].for_me, true);
});

Deno.test("AI 無 @：輪數查詢失敗（舊後台）、存入失敗、舊版存入函式（不回存下的版本）→ 誰都不叫醒", async () => {
  for (const o of [{ chainError: true }, { wakeSet: "error" as const }, { wakeSet: "legacy" as const }]) {
    const f = fake(o);
    f.deps.rank = jev([0.9, 0.9]).rank;
    const r = await read(f.deps);
    assertEquals(r.body.messages[0].for_me, false, JSON.stringify(o));
  }
});

Deno.test("AI 已有 @ 點名：維持原行為（只叫醒被點名者），不查輪數、不走無 @ 流程", async () => {
  const f = fake({ messages: [aiMsg({ mentions: ["w02"] })] });
  f.deps.rank = jev([0.9]).rank;
  assertEquals((await read(f.deps, "w02")).body.messages[0].for_me, true);
  assertEquals(f.calls.filter((c) => c.fn === "asn_relay_room_ai_chain").length, 0);
  const g = fake({ messages: [aiMsg({ mentions: ["H~H-主線"] })] });
  assertEquals((await read(g.deps, "w02")).body.messages[0].for_me, false);
});

Deno.test("AI 無 @：已有存下的 wake_info 就以它為準，不重打 Jev、不重寫", async () => {
  const stored = [{ key: "H~H-主線", label: "H-主線", rank: 1, hold: false }, { key: "w02", label: "W02", rank: 0, hold: true }];
  const j = jev([0.1, 0.9]); // 若重算，w02 會通過；以存下的為準應該不叫醒
  const f = fake({ messages: [aiMsg({ wake_info: stored })] });
  f.deps.rank = j.rank;
  assertEquals((await read(f.deps, "w02")).body.messages[0].for_me, false);
  assertEquals([j.count(), setCalls(f.calls).length], [0, 0]);
  const g = fake({ messages: [aiMsg({ wake_info: stored })] }, "H~H-主線");
  g.deps.rank = j.rank;
  const m = (await read(g.deps, "H~H-主線")).body.messages[0];
  assertEquals([m.for_me, m.wake.rank, m.wake.total], [true, 1, 1]);
});

Deno.test("AI 無 @：寫入競爭輸了（別人先存）→ 以存下的版本為準，不用自己算的", async () => {
  const f = fake();
  f.deps.rank = jev([0.9, 0.9]).rank; // 自己算：兩位都過
  const orig = f.deps.rpc;
  // 別人先存：只有 H-主線通過
  f.deps.rpc = (fn, args) => fn === "asn_relay_room_wake_set"
    ? Promise.resolve({ data: { set: false, wake_info: [{ key: "H~H-主線", label: "H-主線", rank: 1, hold: false }, { key: "w02", label: "W02", rank: 0, hold: true }] }, error: null })
    : orig(fn, args);
  assertEquals((await read(f.deps, "w02")).body.messages[0].for_me, false);
});

Deno.test("AI 無 @：發言者自己、開頭紀錄、系統訊息不叫醒；真人訊息的行為不變", async () => {
  const f = fake({ messages: [aiMsg({ from: "w02" }), aiMsg({ seq: 6, is_seed: true }), aiMsg({ seq: 7, from_kind: "system" })] });
  f.deps.rank = jev([0.9, 0.9]).rank;
  const r = await read(f.deps, "w02");
  assertEquals(r.body.messages.map((m: { for_me: boolean }) => m.for_me), [false, false, false]);
  assertEquals(setCalls(f.calls).length, 0);
  const h = fake({ messages: [{ seq: 5, from: "~owner", from_kind: "human", trust: "owner", body: "大家", mentions: [] }] });
  assert((await read(h.deps)).body.messages[0].for_me);
});
