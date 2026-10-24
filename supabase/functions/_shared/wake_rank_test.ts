// 執行：SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno test -A supabase/functions/_shared/wake_rank_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleNodeRoomAction, type RoomDeps, type RoomMember, wakeOrder } from "./rooms.ts";
import { cachedBy, makeJevScorer, rankConfig, rankFromEnv, rankStats, resetRankStats, scoreWake, type RankInput } from "./wake_rank.ts";

const AIS: RoomMember[] = [
  { key: "~owner", name: "啟良", kind: "owner" },
  { key: "w02", name: "W02", label: "W02（啟良）", kind: "claude" },
  { key: "aegis", name: "牧陽 Aegis", label: "牧陽 Aegis（啟良）", kind: "claude" },
  { key: "H~H-主線", name: "H-主線", label: "H-主線（啟良）", kind: "window" },
];
const OWNER_MSG = { from: "~owner", trust: "owner", mentions: [] as string[] };
const L = { w: "W02（啟良）", a: "牧陽 Aegis（啟良）", h: "H-主線（啟良）" };
const rankOf = (scores: Record<string, number>, selfKey: string, msg: Parameters<typeof wakeOrder>[0] = OWNER_MSG, min = 0.5) =>
  wakeOrder(msg, AIS, selfKey, { scores, min, exemptMentioned: true });

Deno.test("排序：分數高的排前面；同分用固定規則（標示由小到大）穩定排序", () => {
  const s = { [L.w]: 0.6, [L.a]: 0.9, [L.h]: 0.6 };
  assertEquals(rankOf(s, "aegis"), { rank: 1, total: 3, before: [], score: 0.9 });
  assertEquals(rankOf(s, "H~H-主線")!.rank, 2); // 同分 0.6：H-主線 標示小於 W02
  assertEquals(rankOf(s, "w02")!.rank, 3);
  assertEquals(rankOf(s, "w02")!.before, [L.a, L.h]);
});

Deno.test("門檻：低於 0.5 的暫不通知（hold），不進順位；其餘只在通過者之間排", () => {
  const s = { [L.w]: 0.2, [L.a]: 0.7, [L.h]: 0.5 }; // 剛好 0.5 算通過
  const w = rankOf(s, "w02")!;
  assertEquals([w.hold, w.rank, w.score], [true, 0, 0.2]);
  assertEquals(w.total, 2);
  assertEquals(rankOf(s, "aegis"), { rank: 1, total: 2, before: [], score: 0.7 });
  assertEquals(rankOf(s, "H~H-主線"), { rank: 2, total: 2, before: [L.a], score: 0.5 });
  // 門檻可調
  assertEquals(rankOf(s, "H~H-主線", OWNER_MSG, 0.6)!.hold, true);
});

Deno.test("被明確點名的不因低分被略過（可關）；沒有分數的人當作通過", () => {
  const msg = { from: "aegis", trust: "member", mentions: ["w02", "H~H-主線"] };
  const s = { [L.w]: 0.1, [L.h]: 0.9 };
  assertEquals(rankOf(s, "w02", msg), { rank: 2, total: 2, before: [L.h], score: 0.1 });
  assertEquals(wakeOrder(msg, AIS, "w02", { scores: s, min: 0.5, exemptMentioned: false })!.hold, true);
  assertEquals(rankOf({}, "w02", msg)!.hold, undefined);
});

Deno.test("沒給分數＝現行固定順位，欄位形狀不變", () => {
  assertEquals(wakeOrder(OWNER_MSG, AIS, "w02"), { rank: 2, total: 3, before: [L.h] });
});

const input = (labels = [L.w, L.a, L.h]): RankInput => ({ body: "大家看一下", recent: [], candidates: labels.map((l) => ({ id: l, label: l })) });

Deno.test("scoreWake：逾時、出錯、格式不對、少了某人、沒設定 → null（退回固定順位），不丟例外", async () => {
  resetRankStats();
  const never = () => new Promise<Record<string, number>>(() => {});
  assertEquals(await scoreWake(never, input(), { timeoutMs: 30 }), null);
  assertEquals(await scoreWake(() => Promise.reject(new Error("boom")), input(), { timeoutMs: 100 }), null);
  assertEquals(await scoreWake(() => Promise.resolve({ [L.w]: 0.9 }), input(), { timeoutMs: 100 }), null);
  assertEquals(await scoreWake(() => Promise.resolve({ [L.w]: 2, [L.a]: 0.5, [L.h]: 0.5 }), input(), { timeoutMs: 100 }), null);
  assertEquals(await scoreWake(null, input(), { timeoutMs: 100 }), null);
  const st = rankStats();
  assertEquals([st.fallback.timeout, st.fallback.error, st.fallback.bad_result, st.fallback.unset, st.ok], [1, 1, 2, 1, 0]);
  const ok = await scoreWake(() => Promise.resolve({ [L.w]: 0.9, [L.a]: 0.1, [L.h]: 0.5 }), input(), { timeoutMs: 100 });
  assertEquals(ok![L.w], 0.9);
  const s2 = rankStats();
  assertEquals([s2.ok, s2.scores.lt02, s2.scores.lt08 + s2.scores.ge08 + s2.scores.lt05], [1, 1, 2]);
});

Deno.test("快取：同一則訊息只打一次（含同時進行中），失敗不快取", async () => {
  const c = cachedBy<number>();
  let n = 0;
  const make = async () => { n++; await new Promise((r) => setTimeout(r, 10)); return 1; };
  await Promise.all([c("k", make), c("k", make)]);
  await c("k", make);
  assertEquals(n, 1);
  let m = 0;
  await c("f", () => { m++; return Promise.resolve(null); });
  await c("f", () => { m++; return Promise.resolve(1); });
  assertEquals(m, 2);
});

Deno.test("Jev 客戶端：請求格式（Bearer、model/state/questions）與回應解析；內文只在請求裡", async () => {
  let seen: { url: string; auth: string; body: { model: string; state: Record<string, string>; questions: Record<string, { type: string }> } } | null = null;
  const fakeFetch = ((url: string, init: RequestInit) => {
    seen = { url, auth: (init.headers as Record<string, string>).authorization, body: JSON.parse(init.body as string) };
    return Promise.resolve(new Response(JSON.stringify({ answers: { c0: { type: "noul", noul: 0.9 }, c1: { type: "noul", noul: 0.1 }, c2: { type: "noul", noul: 0.5 } } })));
  }) as unknown as typeof fetch;
  const scorer = makeJevScorer({ url: "https://jev.example/x", key: "K", fetch: fakeFetch });
  const r = await scorer(input());
  assertEquals(r, { [L.w]: 0.9, [L.a]: 0.1, [L.h]: 0.5 });
  assertEquals([seen!.url, seen!.auth, seen!.body.model], ["https://jev.example/x", "Bearer K", "jev-1.13.0"]);
  assertEquals(Object.keys(seen!.body.questions), ["c0", "c1", "c2"]);
  assertEquals(seen!.body.questions.c0.type, "noul");
  // 回應格式不對或 HTTP 錯誤會丟例外（scoreWake 接住）
  const bad = ((_u: string, _i: RequestInit) => Promise.resolve(new Response(JSON.stringify({ answers: { c0: { type: "noul", noul: 3 } } })))) as unknown as typeof fetch;
  let threw = false;
  try { await makeJevScorer({ url: "u", key: "k", fetch: bad })(input()); } catch { threw = true; }
  assert(threw);
  const http = ((_u: string, _i: RequestInit) => Promise.resolve(new Response("x", { status: 500 }))) as unknown as typeof fetch;
  threw = false;
  try { await makeJevScorer({ url: "u", key: "k", fetch: http })(input()); } catch { threw = true; }
  assert(threw);
});

Deno.test("設定：預設關閉；門檻 0.5、逾時 3 秒；環境變數可調；壞值退回預設", () => {
  assertEquals(rankConfig(() => undefined), { enabled: false, min: 0.5, timeoutMs: 3000, exemptMentioned: true });
  const e = (o: Record<string, string>) => (k: string) => o[k];
  assertEquals(rankConfig(e({ JEV_RANK_ENABLED: "1", JEV_RANK_MIN: "0.7", JEV_RANK_TIMEOUT_MS: "1500", JEV_RANK_EXEMPT_MENTIONED: "0" })), { enabled: true, min: 0.7, timeoutMs: 1500, exemptMentioned: false });
  assertEquals(rankConfig(e({ JEV_RANK_ENABLED: "1", JEV_RANK_MIN: "9", JEV_RANK_TIMEOUT_MS: "abc" })).min, 0.5);
  assertEquals(rankFromEnv(() => undefined), null);
  assertEquals(rankFromEnv(e({ JEV_RANK_ENABLED: "0", JEV_URL: "u", JEV_KEY: "k" })), null);
});

// ── 接進 room_read ──
const MSGS = [{ seq: 2, from: "~owner", trust: "owner", body: "大家看一下", mentions: [] as string[] }];
function deps(over: Partial<RoomDeps>): RoomDeps {
  return {
    rpc: (fn) => Promise.resolve({
      data: fn === "asn_relay_room_read" ? { key: "w02", last_seq: 2, messages: MSGS } : fn === "asn_relay_room_members" ? { key: "w02", members: AIS } : {},
      error: null,
    }),
    ring: () => Promise.resolve(),
    rosterHas: () => Promise.resolve(true),
    ...over,
  };
}
const readWake = async (d: RoomDeps) => (await handleNodeRoomAction(d, { id: "w02" }, "room_read", { room: "r1", since: "0" })).body.messages[0];
const envOn = (extra: Record<string, string> = {}) => (k: string) => ({ JEV_RANK_ENABLED: "1", JEV_URL: "https://jev.example/x", JEV_KEY: "K", ...extra })[k];
const jevFetch = (scores: number[]) => ((_u: string, _i: RequestInit) =>
  Promise.resolve(new Response(JSON.stringify({ answers: Object.fromEntries(scores.map((s, i) => [`c${i}`, { type: "noul", noul: s }])) })))) as unknown as typeof fetch;

Deno.test("room_read：Jev 分數低的標 hold（for_me 不變），高低分影響順位", async () => {
  // 候選依標示排序：H-主線、W02、牧陽（讀者 w02 的是第二個）
  const low = await readWake(deps({ rank: rankFromEnv(envOn(), jevFetch([0.9, 0.2, 0.6])) }));
  assertEquals([low.for_me, low.wake.hold, low.wake.rank, low.wake.total], [true, true, 0, 2]);
  const hi = await readWake(deps({ rank: rankFromEnv(envOn(), jevFetch([0.6, 0.95, 0.7])) }));
  assertEquals([hi.wake.hold, hi.wake.rank, hi.wake.total, hi.wake.before], [undefined, 1, 3, []]);
});

Deno.test("room_read：Jev 逾時、出錯、沒設定金鑰、沒開 → 退回固定順位，群組照常", async () => {
  const fixed = { rank: 2, total: 3, before: [L.h] };
  const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const t = await readWake(deps({ rank: rankFromEnv(envOn({ JEV_RANK_TIMEOUT_MS: "100" }), hang) }));
  assertEquals(t.wake, fixed);
  const boom = (() => Promise.reject(new Error("net"))) as unknown as typeof fetch;
  assertEquals((await readWake(deps({ rank: rankFromEnv(envOn(), boom) }))).wake, fixed);
  assertEquals((await readWake(deps({ rank: rankFromEnv(envOn({ JEV_KEY: "" }), jevFetch([0, 0, 0])) }))).wake, fixed);
  assertEquals((await readWake(deps({ rank: rankFromEnv(() => undefined) }))).wake, fixed);
  assertEquals((await readWake(deps({}))).wake, fixed);
});

Deno.test("room_read：同一則訊息被兩位讀者讀，只打一次 Jev", async () => {
  let n = 0;
  const f = ((_u: string, _i: RequestInit) => { n++; return Promise.resolve(new Response(JSON.stringify({ answers: { c0: { type: "noul", noul: 0.9 }, c1: { type: "noul", noul: 0.8 }, c2: { type: "noul", noul: 0.7 } } }))); }) as unknown as typeof fetch;
  const rank = rankFromEnv(envOn(), f);
  await readWake(deps({ rank }));
  await readWake(deps({ rank }));
  assertEquals(n, 1);
});
