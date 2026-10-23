// 真人好友與群組 第 1a 期（Edge 端）：人的動作的簽章門檻、輸入整理、邀請碼只給一次、錯誤對應；
// 以及群組規則：shouldRespond（開頭紀錄、系統訊息、額度）、parseMentions 同名消歧、確認請求的節點動作、節點金鑰仍不能建群組。
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  clampSeed, GROUP_ACTIONS, groupErrorText, handleGroupAction, type GroupDeps, inviteLink, signedRpc, validWindowKey,
} from "./groups.ts";
import { handleNodeRoomAction, parseMentions, type RoomDeps, shouldRespond } from "./rooms.ts";

const U = "11111111-1111-1111-1111-111111111111";
const ID = "5f0c4f0e-1111-4111-8111-111111111111";

function mk(opts: { signed?: string | null; reply?: Record<string, unknown> } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rung: string[] = [];
  const deps: GroupDeps = {
    rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve({ data: opts.reply ?? { ok: true }, error: null }); },
    ring: (t) => { rung.push(t); return Promise.resolve(); },
    signedUser: () => Promise.resolve(opts.signed === undefined ? U : opts.signed),
    sha256Hex: async (s) => {
      const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
      return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
    },
    newCode: () => "abcdefghijklmnopqrstuvwx",
  };
  return { deps, calls, rung };
}
const me = { id: "H" };
const sample: Record<string, unknown> = {
  group_create: { name: "群" }, group_invite_create: { kind: "room", room: "g1" }, group_invite_revoke: { id: ID },
  group_invite_preview: { code: "abcdefghijklmnopqrstuvwx" }, group_invite_accept: { code: "abcdefghijklmnopqrstuvwx" },
  group_upgrade: { agent: "財務", extra: ["H~同名"] }, group_leave: { room: "g1" }, group_ai_add: { room: "g1", keys: ["H~a"] },
  group_ai_remove: { room: "g1", key: "H~a" }, group_allow_others: { room: "g1", key: "H~a", allow: false },
  group_confirm_decide: { room: "g1", id: ID, approve: true }, group_confirm_list: { room: "g1" },
};

Deno.test("沒有本人簽章：每個人的動作都 401，而且完全不碰資料庫（AI 只有節點金鑰）", async () => {
  assertEquals([...GROUP_ACTIONS].sort(), Object.keys(sample).sort(), "範例要涵蓋所有動作");
  for (const action of GROUP_ACTIONS) {
    const t = mk({ signed: null });
    const r = await handleGroupAction(t.deps, me, action, sample[action]);
    assertEquals(r.status, 401, action);
    assertEquals(t.calls.length, 0, action + " 不得打資料庫");
  }
});

Deno.test("有簽章：每個動作都打對應的資料庫函式，帶的是簽章的使用者與金鑰所屬節點", async () => {
  for (const action of GROUP_ACTIONS) {
    const t = mk();
    const r = await handleGroupAction(t.deps, me, action, sample[action]);
    assertEquals(r.status, 200, action + JSON.stringify(r.body));
    assertEquals(t.calls.length, 1);
    assertEquals(t.calls[0].fn.startsWith("asn_relay_group_"), true, t.calls[0].fn);
    assertEquals(t.calls[0].args.p_user, U);
    assertEquals(t.calls[0].args.p_node, "H", "節點一律是金鑰所屬的，body 不能指定");
  }
});

Deno.test("body 想偽造使用者或節點：被忽略", async () => {
  const t = mk();
  await handleGroupAction(t.deps, me, "group_create", { name: "群", p_user: "x", user: "x", node: "OTHER", p_node: "OTHER" });
  assertEquals(t.calls[0].args.p_user, U);
  assertEquals(t.calls[0].args.p_node, "H");
});

Deno.test("邀請碼：只在建立當下回給呼叫者，資料庫只收到雜湊；連結格式固定", async () => {
  const t = mk({ reply: { id: ID, kind: "room", expires_at: "x", uses: 1 } });
  const r = await handleGroupAction(t.deps, me, "group_invite_create", { kind: "room", room: "g1" });
  assertEquals(r.body.code, "abcdefghijklmnopqrstuvwx");
  assertEquals(r.body.link, "https://asnmessenger.web.app/i/abcdefghijklmnopqrstuvwx");
  assertEquals(inviteLink("zz"), "https://asnmessenger.web.app/i/zz");
  const sent = JSON.stringify(t.calls[0].args);
  assert(!sent.includes("abcdefghijklmnopqrstuvwx"), "原碼不得送進資料庫");
  assertEquals((t.calls[0].args.p_code_hash as string).length, 64);
  // 預覽與接受也只送雜湊
  const a = mk();
  await handleGroupAction(a.deps, me, "group_invite_accept", { code: "abcdefghijklmnopqrstuvwx" });
  assert(!JSON.stringify(a.calls[0].args).includes("abcdefghijklmnopqrstuvwx"));
  // 建立失敗時不回碼
  const f = mk({ reply: { error: "rate_limited" } });
  const fr = await handleGroupAction(f.deps, me, "group_invite_create", { kind: "room", room: "g1" });
  assertEquals(fr.status, 429); assert(!("code" in fr.body));
});

Deno.test("開頭紀錄則數：預設 40、0～50，超過截成 50、負數截成 0、非數字拒絕", () => {
  assertEquals(clampSeed(undefined), 40);
  assertEquals(clampSeed(0), 0);
  assertEquals(clampSeed(50), 50);
  assertEquals(clampSeed(99), 50);
  assertEquals(clampSeed(-3), 0);
  assertEquals(clampSeed(12.9), 12);
  assertEquals(clampSeed("40"), null);
  assertEquals(clampSeed(NaN), null);
});

Deno.test("輸入檢查：壞資料在打資料庫之前就 400", async () => {
  const bad: [string, unknown][] = [
    ["group_create", { name: "" }], ["group_create", { name: "x".repeat(61) }], ["group_create", { name: "群", ai: ["不是視窗鍵"] }],
    ["group_invite_create", { kind: "friend" }], ["group_invite_create", { kind: "room" }], ["group_invite_create", { kind: "conversation", agent: "a~b" }],
    ["group_invite_create", { kind: "room", room: "g1", seed: "40" }],
    ["group_invite_accept", { code: "短" }], ["group_invite_revoke", { id: "不是 uuid" }],
    ["group_upgrade", { agent: "財務", extra: [] }], ["group_upgrade", { agent: "財務" }],
    ["group_leave", { room: "有 空白" }], ["group_ai_add", { room: "g1", keys: [] }], ["group_ai_add", { room: "g1", keys: ["~u:x"] }],
    ["group_allow_others", { room: "g1", key: "H~a", allow: "no" }], ["group_confirm_decide", { room: "g1", id: ID, approve: "yes" }],
  ];
  for (const [action, body] of bad) {
    const t = mk();
    const r = await handleGroupAction(t.deps, me, action, body);
    assertEquals(r.status, 400, action + JSON.stringify(body));
    assertEquals(t.calls.length, 0);
  }
  assertEquals(validWindowKey("H~財務"), true);
  assertEquals(validWindowKey("~owner"), false);
  assertEquals(validWindowKey("a~b~c"), false);
});

Deno.test("錯誤碼對應狀態與中文；門鈴敲完且不外露在回應裡", async () => {
  const cases: [string, number][] = [
    ["forbidden", 403], ["not_member", 403], ["invalid_invite", 404], ["invite_used", 410], ["invite_expired", 410], ["invite_revoked", 410],
    ["rate_limited", 429], ["room_limit", 409], ["host_must_transfer", 409], ["already_decided", 409], ["expired", 410],
  ];
  for (const [code, status] of cases) {
    const t = mk({ reply: { error: code } });
    const r = await handleGroupAction(t.deps, me, "group_leave", { room: "g1" });
    assertEquals(r.status, status, code);
    assert(groupErrorText(code) !== "操作失敗", code + " 要有中文");
    assert(!/[A-Za-z]{4,}_[a-z]+/.test(String(r.body.detail)), "畫面文字不顯示原始代碼");
  }
  const t = mk({ reply: { id: "g1", bell_topics: ["b1", "b2"] } });
  const r = await handleGroupAction(t.deps, me, "group_create", { name: "群" });
  assertEquals(t.rung, ["b1", "b2"]);
  assert(!("bell_topics" in r.body));
});

Deno.test("signedRpc：有簽章時讀／列表／成員清單改走帶簽章的新函式，發言照舊；其餘函式不帶簽章", async () => {
  const seen: { fn: string; args: Record<string, unknown> }[] = [];
  const base = (fn: string, args: Record<string, unknown>) => { seen.push({ fn, args }); return Promise.resolve({ data: null, error: null }); };
  const f = signedRpc(base, U);
  await f("asn_relay_room_read", { p_node: "H" });
  await f("asn_relay_room_list", { p_node: "H" });
  await f("asn_relay_room_members", { p_node: "H" });
  await f("asn_relay_room_post", { p_node: "H" });
  await f("asn_relay_roster_has", { p_node: "H" });
  assertEquals(seen.map((s) => s.fn), ["asn_relay_group_read", "asn_relay_group_list", "asn_relay_group_members", "asn_relay_room_post", "asn_relay_roster_has"]);
  assertEquals(seen.slice(0, 4).every((s) => s.args.p_signed_user === U), true);
  assertEquals("p_signed_user" in seen[4].args, false);
});

// ===== 群組規則 =====
Deno.test("shouldRespond：開頭紀錄、系統訊息、超過額度的點名都不叫醒；舊規則不變", () => {
  const self = "H~財務";
  assertEquals(shouldRespond({ from: "x:1", trust: "member", mentions: [self] }, self), true, "被別人點名要回（額度內）");
  assertEquals(shouldRespond({ from: "x:1", trust: "member", mentions: [self], wake_ok: false }, self), false, "超過額度只記未讀");
  assertEquals(shouldRespond({ from: "x:1", trust: "owner", mentions: [self], is_seed: true }, self), false, "開頭紀錄不叫醒");
  assertEquals(shouldRespond({ from: "~u:a", trust: "owner", is_seed: true }, self), false);
  assertEquals(shouldRespond({ from: "~u:a", trust: "member", mentions: [self], from_kind: "system" }, self), false);
  assertEquals(shouldRespond({ from: "x:1", trust: "member" }, self), false, "別人沒點名：只累積未讀");
  assertEquals(shouldRespond({ from: "~u:a", trust: "owner" }, self), true, "主人本人沒點名：大家都可回");
  assertEquals(shouldRespond({ from: self, trust: "owner", mentions: [self] }, self), false, "自己發的不回");
  assertEquals(shouldRespond({ from: "~owner", trust: "owner", mentions: ["H~別人"] }, self), false);
});

Deno.test("parseMentions：同名的 AI 只認完整標示或成員鍵；不同名照舊", () => {
  const members = [
    { key: "H~同名", name: "同名", label: "同名（小良）" },
    { key: "x:abc", name: "同名", label: "同名（財務員）" },
    { key: "H~財務", name: "財務", label: "財務（小良）" },
    { key: "x:def", name: "財務員", label: "財務員" },
  ];
  assertEquals(parseMentions("@同名 你好", members), [], "只打夥伴名有歧義，不點任何人");
  assertEquals(parseMentions("@同名（財務員） 你好", members), ["x:abc"]);
  assertEquals(parseMentions("@同名（小良） 請看 @財務 與 @財務員", members), ["H~同名", "H~財務", "x:def"]);
  assertEquals(parseMentions("@x:abc 在嗎", members), ["x:abc"]);
});

const roomDeps = (calls: { fn: string; args: Record<string, unknown> }[], reply: unknown = { id: ID, short: "5f0c4f0e", seq: 3, status: "pending", bell_topics: ["b"] }): RoomDeps => ({
  rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve({ data: reply, error: null }); },
  ring: () => Promise.resolve(), rosterHas: () => Promise.resolve(true),
});

Deno.test("節點金鑰仍不能建群組、加人、移人、改置頂；人的群組動作名也不在節點的路徑上", async () => {
  for (const a of ["room_create", "room_add", "room_remove", "room_pin_set"]) {
    const r = await handleNodeRoomAction(roomDeps([]), me, a, { room: "g1" });
    assertEquals(r.status, 403, a);
  }
  for (const a of GROUP_ACTIONS) {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const r = await handleNodeRoomAction(roomDeps(calls), me, a, { room: "g1", name: "x" });
    assertEquals(r.status, 404, a + " 不在節點路徑上");
    assertEquals(calls.length, 0);
  }
});

Deno.test("確認請求（AI 端）：要指定視窗、類別在清單內、摘要 1～500 字；成功敲門鈴；查放行只傳 uuid", async () => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const d = roomDeps(calls);
  assertEquals((await handleNodeRoomAction(d, me, "room_confirm_request", { room: "g1", kind: "spend", summary: "付款" })).status, 400, "沒指定視窗");
  assertEquals((await handleNodeRoomAction(d, me, "room_confirm_request", { room: "g1", as_agent: "財務", kind: "rm", summary: "x" })).status, 400);
  assertEquals((await handleNodeRoomAction(d, me, "room_confirm_request", { room: "g1", as_agent: "財務", kind: "spend", summary: "" })).status, 400);
  assertEquals((await handleNodeRoomAction(d, me, "room_confirm_request", { room: "g1", as_agent: "財務", kind: "spend", summary: "x".repeat(501) })).status, 400);
  assertEquals(calls.length, 0);
  const ok = await handleNodeRoomAction(d, me, "room_confirm_request", { room: "g1", as_agent: "財務", kind: "data_change", summary: "沖銷 12 筆" });
  assertEquals(ok.status, 200); assertEquals(ok.body.status, "pending");
  assertEquals(calls[0].fn, "asn_relay_group_confirm_request");
  assertEquals(calls[0].args.p_node, "H");
  assertEquals(calls[0].args.p_agent, "財務");
  assertEquals((await handleNodeRoomAction(d, me, "room_confirm_status", { as_agent: "財務", id: "不是 uuid" })).status, 400);
  const st = await handleNodeRoomAction(roomDeps(calls, { status: "approved" }), me, "room_confirm_status", { as_agent: "財務", id: ID });
  assertEquals(st.body.status, "approved");
});
