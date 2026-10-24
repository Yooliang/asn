// 執行：SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno test -A supabase/functions/
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleNodeRoomAction, matchAutoJoins, OWNER_ONLY_ACTIONS, parseMentions, type RoomDeps, type RoomMember, shouldRespond, syncNodeAuto, validatePrefixes } from "./rooms.ts";

const MEMBERS: RoomMember[] = [
  { key: "~owner", name: "啟良", role: "owner", kind: "owner", node_role: "owner" },
  { key: "ROLE1", name: "角色節點", role: "member", kind: "claude", node_role: "owner" },
  { key: "w02", name: "W02", kind: "claude", node_role: "member" },
  { key: "aegis", name: "牧陽 Aegis", kind: "claude", node_role: "member" },
  { key: "H~H-主線-3", name: "H-主線-3", kind: "window", node_role: "member" },
  { key: "H~H-主線", name: "H-主線", kind: "window", node_role: "member" },
  { key: "aegis~小牧", name: "小牧", kind: "window", node_role: "member" },
];

Deno.test("mentions：顯示名、key、中文、含空白的名字、通用別名「主人」", () => {
  assertEquals(parseMentions("@W02 幫忙看一下", MEMBERS), ["w02"]);
  assertEquals(parseMentions("@w02 小寫也行", MEMBERS), ["w02"]);
  assertEquals(parseMentions("請 @小牧 回答，@啟良 也看一下", MEMBERS), ["aegis~小牧", "~owner"]);
  assertEquals(parseMentions("@牧陽 Aegis 總機請看", MEMBERS), ["aegis"]);
  assertEquals(parseMentions("@主人 幫我記", MEMBERS), ["~owner"]);
  assertEquals(parseMentions("@owner 角色節點沒有特別別名", MEMBERS), []);
  assertEquals(parseMentions("沒有點名的一句話，信箱 a@b.com 也不算", MEMBERS), []);
});

Deno.test("mentions：最長的名字優先，英數結尾不會誤中更長名字的前半，重複與上限", () => {
  assertEquals(parseMentions("@H-主線-3 你好", MEMBERS), ["H~H-主線-3"]);
  assertEquals(parseMentions("@H-主線 你好", MEMBERS), ["H~H-主線"]);
  assertEquals(parseMentions("@H-主線-3，@H-主線：兩個都點", MEMBERS), ["H~H-主線-3", "H~H-主線"]);
  assertEquals(parseMentions("@W02 @w02 @W02", MEMBERS), ["w02"]);
  assertEquals(parseMentions("@W022 不是 W02", MEMBERS), []); // 後面接英數＝另一個名字
  assertEquals(parseMentions("@W02 @小牧 @aegis @ROLE1", MEMBERS, 2), ["w02", "aegis~小牧"]);
  // 中文名沒有英數邊界可擋：短名字排在前面時，也要認出較長的那位
  const zh: RoomMember[] = [{ key: "a~小牧", name: "小牧" }, { key: "a~小牧二號", name: "小牧二號" }];
  assertEquals(parseMentions("@小牧二號 你好", zh), ["a~小牧二號"]);
  assertEquals(parseMentions("@小牧 你好", zh), ["a~小牧"]);
});

Deno.test("只回點名或 owner 的判定：owner 發的、被點名的才回；沒點名的成員訊息、自己發的不回", () => {
  const msg = (from: string, trust: string, mentions: string[] = []) => ({ from, trust, mentions });
  assert(shouldRespond(msg("~owner", "owner"), "w02"));             // 啟良發問，不用點名
  assert(shouldRespond(msg("ROLE1", "owner"), "w02"));               // 舊租戶角色節點（owner 角色）的信若被標 owner 也算
  assert(shouldRespond(msg("aegis~小牧", "member", ["w02"]), "w02")); // 被點名
  assert(!shouldRespond(msg("aegis~小牧", "member", ["H~H-主線"]), "w02")); // 點別人
  assert(!shouldRespond(msg("aegis~小牧", "member"), "w02"));       // 成員之間沒點名：只看不回
  assert(!shouldRespond(msg("w02", "member", ["w02"]), "w02"));     // 自己發的
  assert(!shouldRespond(msg("~owner", "owner"), "~owner"));
});

// 假的資料庫與門鈴：記下每一次呼叫
function fake(handlers: Record<string, (args: Record<string, unknown>) => unknown> = {}, roster = true) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rung: string[] = [];
  const deps: RoomDeps = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      const h = handlers[fn];
      return Promise.resolve({ data: h ? h(args) : {}, error: null });
    },
    ring: (t) => { rung.push(t); return Promise.resolve(); },
    rosterHas: () => Promise.resolve(roster),
  };
  return { deps, calls, rung };
}
const ME = { id: "w02" };
const membersOk = () => ({ key: "w02", room: { id: "r1", name: "x" }, members: MEMBERS });

Deno.test("權限：節點（AI，含舊租戶角色節點 ROLE1 的金鑰）呼叫建群組／改置頂／加人／移人一律 403，且完全不碰資料庫", async () => {
  for (const node of [{ id: "w02" }, { id: "ROLE1" }, { id: "H" }]) {
    for (const action of ["room_create", "room_add", "room_remove", "room_pin_set"]) {
      const { deps, calls } = fake();
      const r = await handleNodeRoomAction(deps, node, action, { room: "r1", member: "w02", body: "x", version: 0, name: "n", members: ["w02"] });
      assertEquals([r.status, r.body.error], [403, "forbidden"], `${node.id} ${action}`);
      assertEquals(calls.length, 0, `${node.id} ${action} 不能打到資料庫`);
    }
  }
  assertEquals(OWNER_ONLY_ACTIONS.size, 4);
});

Deno.test("權限：節點發言永遠不能用 owner 身分（p_owner 一律 false），body 裡塞 owner／p_owner 也沒用", async () => {
  const { deps, calls } = fake({ asn_relay_room_members: membersOk, asn_relay_room_post: () => ({ seq: 1, bell_topics: [] }) });
  const r = await handleNodeRoomAction(deps, ME, "room_post", { room: "r1", body: "hi", owner: true, p_owner: true, as_owner: "1" });
  assertEquals(r.status, 200);
  for (const c of calls) assertEquals(c.args.p_owner, false, c.fn);
  assertEquals(calls.at(-1)!.args.p_node, "w02"); // 寄件節點由金鑰決定，不是從 body 來的
});

Deno.test("視窗代發：視窗名不在該節點 roster → 403 且不寫入；名字含 ~ 或太長 → 400；在 roster 內 → 以該視窗發言並解析點名、敲所有成員節點的門鈴", async () => {
  const bad = fake({}, false);
  const r1 = await handleNodeRoomAction(bad.deps, ME, "room_post", { room: "r1", body: "hi", from_agent: "不存在的視窗" });
  assertEquals([r1.status, r1.body.error], [403, "unknown_agent"]);
  assertEquals(bad.calls.length, 0);
  for (const evil of ["H~H-主線", "x".repeat(61)]) {
    const r = await handleNodeRoomAction(bad.deps, ME, "room_post", { room: "r1", body: "hi", from_agent: evil });
    assertEquals([r.status, r.body.error], [400, "bad_agent"]);
  }
  const ok = fake({ asn_relay_room_members: membersOk, asn_relay_room_post: () => ({ seq: 7, bell_topics: ["t1", "t2"] }) });
  const r2 = await handleNodeRoomAction(ok.deps, ME, "room_post", { room: "r1", body: "@小牧 看一下，@啟良 請看", from_agent: "H-視窗" });
  assertEquals([r2.status, r2.body.seq], [200, 7]);
  const post = ok.calls.find((c) => c.fn === "asn_relay_room_post")!;
  assertEquals([post.args.p_agent, post.args.p_mentions], ["H-視窗", ["aegis~小牧", "~owner"]]);
  assertEquals(ok.rung.sort(), ["t1", "t2"]);
});

Deno.test("限流與非成員：資料庫回 rate_limited → 429（不敲門鈴），not_member → 403", async () => {
  const limited = fake({ asn_relay_room_members: membersOk, asn_relay_room_post: () => ({ error: "rate_limited" }) });
  const r = await handleNodeRoomAction(limited.deps, ME, "room_post", { room: "r1", body: "hi" });
  assertEquals([r.status, r.body.error], [429, "rate_limited"]);
  assertEquals(limited.rung.length, 0);
  const out = fake({ asn_relay_room_members: () => ({ error: "not_member" }) });
  const r2 = await handleNodeRoomAction(out.deps, ME, "room_post", { room: "r1", body: "hi" });
  assertEquals([r2.status, r2.body.error], [403, "not_member"]);
  assertEquals(out.calls.some((c) => c.fn === "asn_relay_room_post"), false);
});

Deno.test("讀紀錄：每則帶 for_me（被點名或 owner 發的才為 true）", async () => {
  const { deps } = fake({
    asn_relay_room_read: () => ({
      key: "w02", last_seq: 3,
      messages: [
        { seq: 1, from: "aegis~小牧", trust: "member", body: "閒聊", mentions: [] },
        { seq: 2, from: "aegis~小牧", trust: "member", body: "@W02", mentions: ["w02"] },
        { seq: 3, from: "~owner", trust: "owner", body: "大家", mentions: [] },
      ],
    }),
  });
  const r = await handleNodeRoomAction(deps, ME, "room_read", { room: "r1", since: "0" });
  assertEquals(r.status, 200);
  assertEquals(r.body.messages.map((m: { for_me: boolean }) => m.for_me), [false, true, true]);
});

Deno.test("參數檢查：房號格式不對 → 400；未知動作 → 404", async () => {
  const { deps, calls } = fake();
  assertEquals((await handleNodeRoomAction(deps, ME, "room_read", { room: "../x" })).status, 400);
  assertEquals((await handleNodeRoomAction(deps, ME, "room_post", { room: "r1", body: "" })).status, 400);
  assertEquals((await handleNodeRoomAction(deps, ME, "room_zzz", { room: "r1" })).status, 404);
  assertEquals(calls.length, 0);
});

Deno.test("自動收入：視窗名以開頭字串開頭才入群（區分大小寫、不解析前綴）；多群組同時符合都進；不符合不動", () => {
  const rules = [{ room: "g36", prefixes: ["g36-"] }, { room: "home", prefixes: ["H-"] }, { room: "hg", prefixes: ["H-g36"] }];
  const j = (names: string[]) => matchAutoJoins(rules, names).map((x) => `${x.room}:${x.name}`).sort();
  assertEquals(j(["g36-前端", "g36-後端-2"]), ["g36:g36-前端", "g36:g36-後端-2"]);
  assertEquals(j(["H-主線-3"]), ["home:H-主線-3"]);
  assertEquals(j(["H-g36-前端"]), ["hg:H-g36-前端", "home:H-g36-前端"]); // 同時符合兩個群組，都進
  assertEquals(j(["G36-前端", "h-主線", "x-g36-前端", "g36x-前端", "前端-g36"]), []); // 大小寫不同、中間含有、沒有 - 都不算
  assertEquals(matchAutoJoins([{ room: "r", prefixes: ["", "g36-"] }], ["隨便", "g36-a"]).map((x) => x.name), ["g36-a"]); // 空字串不當萬用
});

Deno.test("自動收入：開頭字串驗證（空字串、全空白、含 ~、太長、太多都不允許）", () => {
  assertEquals(validatePrefixes(["H-", "g36-", "H-"]), ["H-", "g36-"]);
  assertEquals(validatePrefixes([]), []);
  for (const bad of [[""], ["  "], ["a~b"], ["x".repeat(41)], Array.from({ length: 11 }, (_, i) => `p${i}`), [1], "H-", null]) {
    assertEquals(validatePrefixes(bad), null, JSON.stringify(bad));
  }
});

Deno.test("自動收入：syncNodeAuto 用規則算出該入群的視窗交給資料庫；規則取不到只記 log 不丟錯", async () => {
  const { deps, calls } = fake({ asn_relay_room_auto_rules: () => [{ room: "g36", prefixes: ["g36-"] }] });
  await syncNodeAuto(deps, "H", ["g36-前端", "別的"]);
  assertEquals(calls.find((c) => c.fn === "asn_relay_room_auto_rules")!.args, { p_node: "H" }, "規則只取這個節點所屬租戶的群組");
  const apply = calls.find((c) => c.fn === "asn_relay_room_auto_apply")!;
  assertEquals(apply.args, { p_node: "H", p_joins: [{ room: "g36", name: "g36-前端" }] });
  const broken: RoomDeps = { ...deps, rpc: () => Promise.resolve({ data: null, error: new Error("boom") }) };
  await syncNodeAuto(broken, "H", ["x"]); // 不丟
});

Deno.test("點名要完全相同：@I-Irori 不會點到 I-Irori-2；中文名後面要接空白或標點", () => {
  const ms = [
    { key: "H~I-Irori", name: "I-Irori" },
    { key: "H~I-Irori-2", name: "I-Irori-2" },
    { key: "aegis~小牧", name: "小牧" },
  ] as unknown as RoomMember[];
  assertEquals(parseMentions("@I-Irori 我在試", ms), ["H~I-Irori"]);
  assertEquals(parseMentions("@I-Irori-2，你看", ms), ["H~I-Irori-2"]);
  assertEquals(parseMentions("@I-Iror 看", ms), []);
  assertEquals(parseMentions("@I-Irori-3 看", ms), []);
  assertEquals(parseMentions("@小牧幫我看", ms), []);
  assertEquals(parseMentions("@小牧 幫我看", ms), ["aegis~小牧"]);
});

Deno.test("owner 發話有點名時只有被點名的回", () => {
  const msg = { from: "~owner", trust: "owner", mentions: ["H~I-Irori"] };
  assertEquals(shouldRespond(msg, "H~I-Irori"), true);
  assertEquals(shouldRespond(msg, "H~I-Irori-2"), false);
  assertEquals(shouldRespond({ from: "~owner", trust: "owner", mentions: [] }, "H~I-Irori-2"), true);
});

Deno.test("去 Irori 化守門（#14 R7）：rooms.ts 不寫死特定人名或角色名；角色節點沒有額外別名", async () => {
  const src = await Deno.readTextFile(new URL("./rooms.ts", import.meta.url));
  for (const word of ["希緒", "小良哥"]) assert(!src.includes(word), `rooms.ts 不該出現「${word}」`);
  const only: RoomMember[] = [{ key: "ROLE1", name: "角色節點", node_role: "owner" }];
  assertEquals(parseMentions("@主人 你好", only), []);
  assertEquals(parseMentions("@角色節點 你好", only), ["ROLE1"]);
});

Deno.test("回覆某則訊息（#225）：帶有效的 reply_to 走 asn_relay_room_post_reply 並傳 p_reply_to_seq；沒帶或不合格的照舊走 asn_relay_room_post（舊用戶端相容）", async () => {
  const mk = () => fake({ asn_relay_room_members: membersOk, asn_relay_room_post: () => ({ seq: 8, bell_topics: [] }), asn_relay_room_post_reply: () => ({ seq: 9, bell_topics: [] }) });
  const a = mk();
  const r = await handleNodeRoomAction(a.deps, ME, "room_post", { room: "r1", body: "好", reply_to: 5 });
  assertEquals([r.status, r.body.seq], [200, 9]);
  const call = a.calls.find((c) => c.fn === "asn_relay_room_post_reply")!;
  assertEquals([call.args.p_reply_to_seq, call.args.p_body, call.args.p_owner], [5, "好", false]);
  assert(!a.calls.some((c) => c.fn === "asn_relay_room_post"), "有引用就只打回覆版，不寫兩次");
  // 字串數字（查詢參數）也認；其餘不合格的當沒有引用，走舊函式
  const s = mk();
  await handleNodeRoomAction(s.deps, ME, "room_post", { room: "r1", body: "好", reply_to: "12" });
  assertEquals(s.calls.find((c) => c.fn === "asn_relay_room_post_reply")!.args.p_reply_to_seq, 12);
  for (const bad of [undefined, null, 0, -3, 1.5, "x", "1e3", {}, [5], true]) {
    const b = mk();
    const rb = await handleNodeRoomAction(b.deps, ME, "room_post", { room: "r1", body: "好", reply_to: bad });
    assertEquals([rb.status, rb.body.seq], [200, 8], String(bad));
    assert(!b.calls.some((c) => c.fn === "asn_relay_room_post_reply"), `reply_to=${JSON.stringify(bad)} 不該走回覆版`);
  }
});
