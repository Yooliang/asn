// 群組訊息下方的順序標籤（#231）：叫醒結果第一次算出就存在訊息上。
// 執行：SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno test -A supabase/functions/_shared/wake_info_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleNodeRoomAction, type RoomDeps, type RoomMember, wakeInfoOf } from "./rooms.ts";
import { rankFromEnv } from "./wake_rank.ts";

const AIS: RoomMember[] = [
  { key: "~owner", name: "啟良", kind: "owner" },
  { key: "w02", name: "W02", label: "W02（啟良）", kind: "claude" },
  { key: "aegis", name: "牧陽 Aegis", label: "牧陽 Aegis（啟良）", kind: "claude" },
  { key: "H~H-主線", name: "H-主線", label: "H-主線（啟良）", kind: "window" },
  { key: "~u:abc", name: "阿明", label: "阿明", kind: "human" },
];
const ME = { id: "w02" };
function fake(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const deps: RoomDeps = {
    rpc: (fn, args) => { calls.push({ fn, args }); const h = handlers[fn]; return Promise.resolve({ data: h ? h(args) : {}, error: null }); },
    ring: () => Promise.resolve(),
    rosterHas: () => Promise.resolve(true),
  };
  return { deps, calls };
}
const OWNER_MSG = { seq: 2, from: "~owner", trust: "owner", body: "大家", mentions: [] as string[] };

Deno.test("wake_info：依順序列出被叫醒的 AI；分數低於門檻的標略過（排最後）；沒被叫醒回 null；真人不列", () => {
  const msg = { from: "~owner", trust: "owner", mentions: [] as string[] };
  const fixed = wakeInfoOf(msg, AIS, "w02")!;
  assertEquals(fixed.map((e) => [e.key, e.rank, e.hold]), [["H~H-主線", 1, false], ["w02", 2, false], ["aegis", 3, false]]);
  const scored = wakeInfoOf(msg, AIS, "w02", { scores: { "W02（啟良）": 0.9, "牧陽 Aegis（啟良）": 0.2, "H-主線（啟良）": 0.6 }, min: 0.5, exemptMentioned: true })!;
  assertEquals(scored.map((e) => [e.key, e.rank, e.hold]), [["w02", 1, false], ["H~H-主線", 2, false], ["aegis", 0, true]]);
  assertEquals(wakeInfoOf({ from: "w02", trust: "member", mentions: [] }, AIS, "aegis"), null);
});

Deno.test("room_read：第一次算出就存回訊息；已有值不再寫；沒被叫醒不寫；寫入失敗不影響讀取；只存順序不存內文", async () => {
  const messages = [
    { seq: 1, from: "aegis~小牧", trust: "member", body: "閒聊", mentions: [] },
    OWNER_MSG,
    { seq: 3, from: "~owner", trust: "owner", body: "再一則", mentions: [], wake_info: [{ key: "w02", label: "W02", rank: 1, hold: false }] },
  ];
  const { deps, calls } = fake({ asn_relay_room_read: () => ({ key: "w02", last_seq: 3, messages }), asn_relay_room_members: () => ({ key: "w02", members: AIS }), asn_relay_room_wake_set: () => ({ set: true }) });
  const r = await handleNodeRoomAction(deps, ME, "room_read", { room: "r1", since: "0", as_agent: "視窗甲" });
  assertEquals(r.status, 200);
  const sets = calls.filter((c) => c.fn === "asn_relay_room_wake_set");
  assertEquals(sets.length, 1, "只有 seq 2 要寫");
  assertEquals([sets[0].args.p_seq, sets[0].args.p_room, sets[0].args.p_agent], [2, "r1", "視窗甲"]);
  assertEquals((sets[0].args.p_info as { key: string }[]).map((e) => e.key), ["H~H-主線", "w02", "aegis"]);
  assert(!JSON.stringify(sets[0].args).includes("大家"));
  const broken: RoomDeps = { ...deps, rpc: (fn, args) => fn === "asn_relay_room_wake_set" ? Promise.resolve({ data: null, error: "no function" }) : deps.rpc(fn, args) };
  const r2 = await handleNodeRoomAction(broken, ME, "room_read", { room: "r1", since: "0" });
  assertEquals([r2.status, r2.body.messages[1].for_me], [200, true]);
});

const envOn = () => (k: string) => ({ JEV_RANK_ENABLED: "1", JEV_URL: "https://jev.example/x", JEV_KEY: "K" } as Record<string, string>)[k];
const jevFetch = (scores: number[]) => ((_u: string, _i: RequestInit) =>
  Promise.resolve(new Response(JSON.stringify({ answers: Object.fromEntries(scores.map((s, i) => [`c${i}`, { type: "noul", noul: s }])) })))) as unknown as typeof fetch;

Deno.test("room_read：Jev 的結果一併存下（略過者標 hold）；Jev 失敗時存固定順位", async () => {
  const mk = (rank: RoomDeps["rank"]) => {
    const { deps, calls } = fake({ asn_relay_room_read: () => ({ key: "w02", last_seq: 2, messages: [OWNER_MSG] }), asn_relay_room_members: () => ({ key: "w02", members: AIS }), asn_relay_room_wake_set: () => ({ set: true }) });
    return { deps: { ...deps, rank }, calls };
  };
  // 候選依標示排序：H-主線、W02、牧陽
  const jev = mk(rankFromEnv(envOn(), jevFetch([0.9, 0.2, 0.6])));
  await handleNodeRoomAction(jev.deps, ME, "room_read", { room: "r1", since: "0" });
  const info = jev.calls.find((c) => c.fn === "asn_relay_room_wake_set")!.args.p_info as { key: string; rank: number; hold: boolean }[];
  assertEquals(info.map((e) => [e.key, e.rank, e.hold]), [["H~H-主線", 1, false], ["aegis", 2, false], ["w02", 0, true]]);
  const down = mk(rankFromEnv(envOn(), (() => Promise.reject(new Error("net"))) as unknown as typeof fetch));
  await handleNodeRoomAction(down.deps, ME, "room_read", { room: "r1", since: "0" });
  const info2 = down.calls.find((c) => c.fn === "asn_relay_room_wake_set")!.args.p_info as { key: string; hold: boolean }[];
  assertEquals(info2.map((e) => [e.key, e.hold]), [["H~H-主線", false], ["w02", false], ["aegis", false]]);
});
