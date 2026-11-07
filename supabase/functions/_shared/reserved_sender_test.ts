import { assertEquals } from "jsr:@std/assert@1";
import { badSenderName, foldName, isReservedSender } from "./reserved_sender.ts";
import { nodeAction, type OpsDeps } from "./relay_ops.ts";
import { handleNodeRoomAction, type RoomDeps } from "./rooms.ts";

Deno.test("保留字：「ASN 通知」不管空白、標點、大小寫、全形、夾零寬或方向字元、重音，都是保留", () => {
  for (const n of ["ASN 通知", "ASN通知", "asn 通知", "Asn　通知", "ＡＳＮ 通知", "A​SN 通‍知", "ASN‮ 通知", " ASN  通知 ", "ASN\t通知\n",
    "ASN-通知", "ASN・通知", "ASN．通知", "ASN_通知", "ASN：通知", "[ASN] 通知", "ÁSN通知", "ASN通知!"]) {
    assertEquals(isReservedSender(n), true, JSON.stringify(n));
  }
});

Deno.test("保留字：長得像的外國字母", () => {
  for (const n of ["АЅΝ通知", "аѕν通知", "ɑꜱɴ通知", "ᴀѕո通知", "AѕN通知", "аSN 通知"]) {
    assertEquals(isReservedSender(n), true, JSON.stringify(n));
  }
});

Deno.test("保留字：以「收發室」結尾的名字都是保留（含簡體、日文字形、混搭、後面接標點、夾空白或零寬字元）；只有自己節點的預設橋名放行", () => {
  for (const n of ["登入通知收發室", "收發室", "看畫面收發室", "X-收發室", "登入通知收发室", "登入通知収発室", "登入通知收発室", "登入通知収發室", "登入通知収发室",
    "登入通知收發室。", "登入通知收發室！", "登入通知收發室 ", "登入通知收發​室", "登入通知收發室​", "登入通知收發室...", "登入通知(收發室)"]) {
    assertEquals(isReservedSender(n, "H"), true, JSON.stringify(n));
  }
  assertEquals(isReservedSender("H-收發室", "H"), false, "自己這台的預設橋名：橋本來就用它寄系統信");
  assertEquals(isReservedSender("H-收發室", "W"), true, "別台的橋名不行");
  assertEquals(isReservedSender("H-收發室 ", "H"), true, "不是逐字的預設橋名");
  assertEquals(isReservedSender("h-收發室", "H"), true, "大小寫不同的不放行");
  assertEquals(isReservedSender("H-收發室", null), true, "不知道是哪台就不放行");
  assertEquals(isReservedSender("ASN 通知", "ASN 通知"), true, "節點代號長得像保留名也不能因此放行（沒有『-收發室』的逐字相等）");
});

Deno.test("保留字：一般名字不受影響", () => {
  for (const n of ["小乙", "H-主線", "W02", "收發室工具人", "通知小幫手", "ASN", "ASN 助手", "我的收發室筆記", "ASN2 通知小幫手", "", null, undefined, 5, {}]) {
    assertEquals(isReservedSender(n, "H"), false, JSON.stringify(n));
  }
  assertEquals(foldName("ＡＳＮ 通知"), "asn通知");
  assertEquals(foldName("収発室"), "收發室", "日文字形也折成繁體");
  assertEquals(foldName("АЅΝ-通知"), "asn通知");
});

Deno.test("寫入前檢查：長度與寫入的值", () => {
  const pad = "甲".repeat(97);
  // 寫入端會截斷
  assertEquals(isReservedSender(pad + "收發室垃圾字元", "H"), false, "完整字串本身不是保留");
  assertEquals(badSenderName(pad + "收發室垃圾字元", "H"), true, "寫入的值要看");
  assertEquals(badSenderName(pad + "收發室", "H"), true);
  assertEquals(badSenderName("a".repeat(101), "H"), true, "超過 100 字一律拒絕");
  assertEquals(badSenderName("a".repeat(100), "H"), false, "剛好 100 字的一般名字可以");
  assertEquals(badSenderName("小乙", "H"), false);
  assertEquals(badSenderName("H-收發室", "H"), false, "自己的預設橋名照樣放行");
  assertEquals(badSenderName(undefined, "H"), false);
  assertEquals(badSenderName(5, "H"), false);
});

// ---- 各個入口 ----
const WHO = { tenant: "ta", node: "ROLE1" };
function opsFake() {
  const calls: string[] = [];
  const deps: OpsDeps = { rpc: (fn) => { calls.push(fn); return Promise.resolve({ data: { id: "11111111-1111-4111-8111-111111111111", bell_topic: "b" }, error: null }); }, ring: () => Promise.resolve() };
  return { deps, calls };
}

Deno.test("relay_ops 的 send：保留的寄件名回 400 bad_request、不碰資料庫；一般名字與自己的橋名照常", async () => {
  const f = opsFake();
  for (const n of ["ASN 通知", "登入通知收發室", "OTHER-收發室", "ASN-通知", "登入通知收發室。", "甲".repeat(97) + "收發室垃圾字元", "a".repeat(101)]) {
    const r = await nodeAction(f.deps, WHO, "send", { to_node: "H", body: "x", from_agent: n });
    assertEquals([r.status, r.body], [400, { error: "bad_request" }], n.slice(0, 20));
  }
  assertEquals(f.calls, []);
  assertEquals((await nodeAction(f.deps, WHO, "send", { to_node: "H", body: "x", from_agent: "ROLE1-收發室" })).status, 200);
  assertEquals((await nodeAction(f.deps, WHO, "send", { to_node: "H", body: "x", from_agent: "小乙" })).status, 200);
  assertEquals((await nodeAction(f.deps, WHO, "send", { to_node: "H", body: "x" })).status, 200);
});

Deno.test("群組動作：as_agent／from_agent 是保留名字回 400 bad_agent；一般名字不受影響", async () => {
  const rpcs: string[] = [];
  const deps = { rpc: (fn: string) => { rpcs.push(fn); return Promise.resolve({ data: {}, error: null }); }, ring: () => Promise.resolve(), rosterHas: () => Promise.resolve(true) } as unknown as RoomDeps; // 名單裡有這個名字：保留字檢查在名單檢查之前就擋掉
  const me = { id: "H" };
  for (const p of [{ as_agent: "ASN 通知" }, { from_agent: "登入通知收發室" }, { as_agent: "W-收發室" }, { as_agent: "ASN-通知" }]) {
    const r = await handleNodeRoomAction(deps, me, "room_post", { room: "r1", body: "hi", ...p });
    assertEquals([r.status, (r.body as { error: string }).error], [400, "bad_agent"], JSON.stringify(p));
  }
  assertEquals(rpcs, []);
  const ok = await handleNodeRoomAction(deps, me, "room_post", { room: "r1", body: "hi", as_agent: "H-收發室" });
  assertEquals(ok.status === 400 && (ok.body as { error: string }).error === "bad_agent", false, "自己的橋名不被保留字擋");
});

// 入口都有接上（relay/index.ts 與舊的 irori-relay 是 Deno.serve，沒辦法單元測，用原始碼守門）
Deno.test("守門：send 入口都在寫入前先做檢查", async () => {
  for (const file of ["../relay/index.ts", "../irori-relay/index.ts"]) {
    const src = await Deno.readTextFile(new URL(file, import.meta.url));
    const start = src.indexOf('action === "send" && req.method === "POST"');
    const guard = src.indexOf("badSenderName(b.from_agent, me.id)", start);
    const write = Math.min(...['rpc("asn_relay_send', 'rpc("irori_relay_send', "sendWithPerson("].map((k) => { const i = src.indexOf(k, start); return i < 0 ? Infinity : i; }));
    assertEquals(start > 0 && guard > start && guard < write, true, file);
    assertEquals(src.includes("v.slice(0, 100)"), true, file + "：截斷長度要和檢查用的一樣（100）");
  }
  const ops = await Deno.readTextFile(new URL("./relay_ops.ts", import.meta.url));
  assertEquals(ops.includes("badSenderName(b.from_agent, who.node)"), true);
  assertEquals(ops.includes("v.slice(0, 100)"), true);
  const rooms = await Deno.readTextFile(new URL("./rooms.ts", import.meta.url));
  assertEquals(rooms.includes("isReservedSender(agent, me.id)"), true);
});
