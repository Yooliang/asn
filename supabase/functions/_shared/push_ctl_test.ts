import { assert, assertEquals } from "jsr:@std/assert@1";
import { CONFIRM_GAP_MS, handlePushAction, notifyPush, PUSH_ACTIONS } from "./push_ctl.ts";
import type { Fcm, FcmResult } from "./push_fcm.ts";

const ME = { id: "phn1a1" };
const USER = "11111111-1111-1111-1111-111111111111";
const MSG = "22222222-2222-2222-2222-222222222222";
const TOK = "f".repeat(40) + ":APA91b_tok-1";
const TOK2 = "e".repeat(40) + ":APA91b_tok-2";

type Call = { fn: string; args: Record<string, unknown> };
// deno-lint-ignore no-explicit-any
function mk(answers: Record<string, any> = {}) {
  const calls: Call[] = [];
  const rpc = (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    const a = answers[fn];
    if (a instanceof Error) throw a;
    return Promise.resolve(a === undefined ? { data: {}, error: null } : (a.error !== undefined ? a : { data: a, error: null }));
  };
  return { rpc, calls };
}
function fcmReturning(...rs: FcmResult[]) {
  const sent: string[] = [];
  const fcm: Fcm = { send: (t) => { sent.push(t); return Promise.resolve(rs[Math.min(sent.length - 1, rs.length - 1)]); } };
  return { fcm, sent };
}
async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const orig = { w: console.warn, e: console.error, l: console.log };
  const rec = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.warn = console.error = console.log = rec;
  try { await fn(); } finally { console.warn = orig.w; console.error = orig.e; console.log = orig.l; }
  return out.join("\n");
}
const ok = (): FcmResult => ({ status: 200, invalid: false });
const targets2 = { targets: [{ node: "phn1a1", token: TOK }, { node: "phn2b2", token: TOK2 }] };

Deno.test("動作清單只有註冊與取消", () => {
  assertEquals([...PUSH_ACTIONS].sort(), ["push_register", "push_unregister"]);
});

Deno.test("註冊：節點只取自金鑰（me），用戶端給的 node 不採用；回應不含權杖", async () => {
  const m = mk({ asn_relay_push_register: { ok: true } });
  const r = await handlePushAction({ rpc: m.rpc }, ME, "push_register", { token: TOK, node: "wrk9b2", p_node: "wrk9b2", user: USER });
  assertEquals(r, { status: 200, body: { ok: true } });
  assertEquals(m.calls, [{ fn: "asn_relay_push_register", args: { p_node: "phn1a1", p_token: TOK } }]);
  assertEquals(JSON.stringify(r).includes(TOK), false);
});

Deno.test("註冊：權杖格式不對不打資料庫；資料庫拒絕（非手機節點）轉成 400", async () => {
  const m = mk();
  for (const t of [undefined, null, 5, "", "短", "x".repeat(31), "x".repeat(1025), "a".repeat(40) + " 空白", "a".repeat(40) + "\n", "a".repeat(40) + "中"]) {
    assertEquals((await handlePushAction({ rpc: m.rpc }, ME, "push_register", { token: t })).status, 400, String(t));
  }
  assertEquals((await handlePushAction({ rpc: m.rpc }, ME, "push_register", null as never)).status, 400);
  assertEquals(m.calls.length, 0);
  const r = await handlePushAction({ rpc: mk({ asn_relay_push_register: { error: "bad_request" } }).rpc }, ME, "push_register", { token: TOK });
  assertEquals(r.status, 400);
});

Deno.test("取消：只取消自己；資料庫錯誤回 internal，log 不含權杖", async () => {
  const m = mk();
  assertEquals((await handlePushAction({ rpc: m.rpc }, ME, "push_unregister", { node: "wrk9b2" })).status, 200);
  assertEquals(m.calls, [{ fn: "asn_relay_push_unregister", args: { p_node: "phn1a1" } }]);
  const e = mk({ asn_relay_push_register: { data: null, error: { message: `bad ${TOK}` } } });
  const logs = await captureLogs(async () => { assertEquals((await handlePushAction({ rpc: e.rpc }, ME, "push_register", { token: TOK })).body.error, "internal"); });
  assertEquals(logs.includes(TOK), false);
});

Deno.test("沒設秘密：安靜不送，連『要推誰』都不問（不吃掉 60 秒名額）、也不丟例外", async () => {
  const m = mk({ asn_relay_push_recipient_mail: { user: USER } });
  await notifyPush({ rpc: m.rpc, fcm: null }, "owner_mail", "wrk9b2", MSG);
  await notifyPush({ rpc: m.rpc, fcm: null }, "waiting", "wrk9b2", null);
  assertEquals(m.calls.length, 0);
});

Deno.test("寄給本人：收件人用這封信查（只認這台寄出的）；推給資料庫回的每台，文字由 FCM 層決定", async () => {
  const m = mk({ asn_relay_push_recipient_mail: { user: USER }, asn_relay_push_targets: targets2 });
  const f = fcmReturning(ok());
  await notifyPush({ rpc: m.rpc, fcm: f.fcm }, "owner_mail", "wrk9b2", MSG);
  assertEquals(m.calls[0], { fn: "asn_relay_push_recipient_mail", args: { p_node: "wrk9b2", p_message_id: MSG } });
  assertEquals(m.calls[1], { fn: "asn_relay_push_targets", args: { p_user: USER, p_kind: "owner_mail" } });
  assertEquals(f.sent, [TOK, TOK2]);
  assertEquals(m.calls.length, 2, "都成功就不刪任何權杖");
});

Deno.test("夥伴在等你：收件人是金鑰所屬節點的擁有者；沒有信編號也能推", async () => {
  const m = mk({ asn_relay_push_recipient_node: { user: USER }, asn_relay_push_targets: { targets: [{ node: "phn1a1", token: TOK }] } });
  const f = fcmReturning(ok());
  await notifyPush({ rpc: m.rpc, fcm: f.fcm }, "waiting", "wrk9b2", null);
  assertEquals(m.calls[0], { fn: "asn_relay_push_recipient_node", args: { p_node: "wrk9b2" } });
  assertEquals(m.calls[1], { fn: "asn_relay_push_targets", args: { p_user: USER, p_kind: "waiting" } });
  assertEquals(f.sent, [TOK]);
});

Deno.test("查不到收件人（不是寄給本人、不是這台寄的、信編號缺）：不問推給誰、不送", async () => {
  for (const [kind, ans, mid] of [
    ["owner_mail", { asn_relay_push_recipient_mail: { user: null } }, MSG],
    ["owner_mail", { asn_relay_push_recipient_mail: { user: "不是 uuid" } }, MSG],
    ["owner_mail", {}, null],
    ["waiting", { asn_relay_push_recipient_node: { user: null } }, null],
    ["owner_mail", { asn_relay_push_recipient_mail: { data: null, error: { message: "x" } } }, MSG],
  ] as const) {
    const m = mk(ans);
    const f = fcmReturning(ok());
    await notifyPush({ rpc: m.rpc, fcm: f.fcm }, kind, "wrk9b2", mid);
    assertEquals(m.calls.some((c) => c.fn === "asn_relay_push_targets"), false, JSON.stringify(ans));
    assertEquals(f.sent.length, 0);
  }
});

Deno.test("明確的 UNREGISTERED：只刪那一台的權杖（節點和權杖要對得上）", async () => {
  const m = mk({ asn_relay_push_recipient_mail: { user: USER }, asn_relay_push_targets: targets2 });
  const f = fcmReturning({ status: 404, invalid: true }, ok());
  await notifyPush({ rpc: m.rpc, fcm: f.fcm }, "owner_mail", "wrk9b2", MSG);
  const inv = m.calls.filter((c) => c.fn === "asn_relay_push_invalid");
  assertEquals(inv, [{ fn: "asn_relay_push_invalid", args: { p_node: "phn1a1", p_token: TOK } }]);
});

Deno.test("400：同一輪有台成功才算該權杖壞；全部 400＝我們寫錯，一個都不刪、記一筆停手", async () => {
  const some = mk({ asn_relay_push_recipient_mail: { user: USER }, asn_relay_push_targets: targets2 });
  await notifyPush({ rpc: some.rpc, fcm: fcmReturning({ status: 400, invalid: false }, ok()).fcm }, "owner_mail", "wrk9b2", MSG);
  assertEquals(some.calls.filter((c) => c.fn === "asn_relay_push_invalid").length, 1);
  const all = mk({ asn_relay_push_recipient_mail: { user: USER }, asn_relay_push_targets: targets2 });
  const logs = await captureLogs(() => notifyPush({ rpc: all.rpc, fcm: fcmReturning({ status: 400, invalid: false }).fcm }, "owner_mail", "wrk9b2", MSG));
  assertEquals(all.calls.filter((c) => c.fn === "asn_relay_push_invalid").length, 0, "全部 400 不刪");
  assert(logs.includes("push all_4xx"), logs);
  const single = mk({ asn_relay_push_recipient_mail: { user: USER }, asn_relay_push_targets: { targets: [targets2.targets[0]] } });
  await notifyPush({ rpc: single.rpc, fcm: fcmReturning({ status: 400, invalid: false }).fcm }, "owner_mail", "wrk9b2", MSG);
  assertEquals(single.calls.some((c) => c.fn === "asn_relay_push_invalid"), false, "只有一台又是 400：分不出是權杖還是我們，不刪");
});

Deno.test("整批 404（例如專案代號設錯）：權杖一個都不能刪；同一輪有成功的才刪那台沒有錯誤碼的 404", async () => {
  const bare404: FcmResult = { status: 404, invalid: false };
  const all = mk({ asn_relay_push_recipient_mail: { user: USER }, asn_relay_push_targets: targets2 });
  const logs = await captureLogs(() => notifyPush({ rpc: all.rpc, fcm: fcmReturning(bare404).fcm }, "owner_mail", "wrk9b2", MSG));
  assertEquals(all.calls.filter((c) => c.fn === "asn_relay_push_invalid").length, 0, "整批 404 不能把權杖刪光");
  assert(logs.includes("push all_4xx"), logs);
  const one = mk({ asn_relay_push_recipient_mail: { user: USER }, asn_relay_push_targets: { targets: [targets2.targets[0]] } });
  await notifyPush({ rpc: one.rpc, fcm: fcmReturning(bare404).fcm }, "owner_mail", "wrk9b2", MSG);
  assertEquals(one.calls.some((c) => c.fn === "asn_relay_push_invalid"), false, "只有一台又是 404：分不出，不刪");
  const some = mk({ asn_relay_push_recipient_mail: { user: USER }, asn_relay_push_targets: targets2 });
  await notifyPush({ rpc: some.rpc, fcm: fcmReturning(bare404, ok()).fcm }, "owner_mail", "wrk9b2", MSG);
  assertEquals(some.calls.filter((c) => c.fn === "asn_relay_push_invalid"), [{ fn: "asn_relay_push_invalid", args: { p_node: "phn1a1", p_token: TOK } }]);
  const mixed = mk({ asn_relay_push_recipient_mail: { user: USER }, asn_relay_push_targets: targets2 });
  await notifyPush({ rpc: mixed.rpc, fcm: fcmReturning({ status: 404, invalid: true }, bare404).fcm }, "owner_mail", "wrk9b2", MSG);
  assertEquals(mixed.calls.filter((c) => c.fn === "asn_relay_push_invalid").length, 1, "明確 UNREGISTERED 照刪，沒有錯誤碼的那台不刪");
});

Deno.test("任何失敗都不丟例外：資料庫丟例外、FCM 丟例外、targets 回錯", async () => {
  const boom = new Error(`x ${TOK}`);
  const logs = await captureLogs(async () => {
    await notifyPush({ rpc: mk({ asn_relay_push_recipient_mail: boom }).rpc, fcm: fcmReturning(ok()).fcm }, "owner_mail", "wrk9b2", MSG);
    const m = mk({ asn_relay_push_recipient_mail: { user: USER }, asn_relay_push_targets: targets2 });
    await notifyPush({ rpc: m.rpc, fcm: { send: () => Promise.reject(boom) } }, "owner_mail", "wrk9b2", MSG);
    await notifyPush({ rpc: mk({ asn_relay_push_recipient_mail: { user: USER }, asn_relay_push_targets: { error: "bad_request" } }).rpc, fcm: fcmReturning(ok()).fcm }, "owner_mail", "wrk9b2", MSG);
  });
  assertEquals(logs.includes(TOK), false, "例外內容不進 log");
});

Deno.test("沒有要推的（不在線、60 秒內、沒權杖）：不送", async () => {
  const m = mk({ asn_relay_push_recipient_mail: { user: USER }, asn_relay_push_targets: { targets: [] } });
  const f = fcmReturning(ok());
  await notifyPush({ rpc: m.rpc, fcm: f.fcm }, "owner_mail", "wrk9b2", MSG);
  assertEquals(f.sent.length, 0);
});

// 守門：index.ts 的接法。收件人不能取自用戶端；只有寄給本人那條路（有 fanout）和 waiting 通知真的寄出才推
Deno.test("守門：relay/index.ts 只在『寄給本人』『等待通知寄出』『建立確認請求成功』之後推，且不把用戶端參數傳進去", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  const calls = [...src.matchAll(/notifyPush\(\{.*?, fcm \}, "(\w+)", ([^)]*)\)/g)].map((m) => [m[1], m[2].trim()]);
  assertEquals(calls.sort(), [["confirm", "me.id, id"], ["confirm", "me.id, id"], ["owner_mail", "me.id, sent.id"], ["waiting", "me.id, null"]]);   // confirm：建立請求成功後（onCreated）才推，編號來自資料庫回應
  assert(src.includes('typeof (sent as { fanout?: unknown }).fanout === "number"'), "寄給本人才有 fanout");
  assert(src.includes('data?.notify === "sent"'));
  assertEquals(src.includes("p_user"), false, "index.ts 不自己組收件人");
});

Deno.test("需要你確認：同一台 10 秒內只推一則（防洪在這裡，資料庫不擋 60 秒）；不同台各自算", async () => {
  const contents: unknown[] = [];
  const fcm = { send: (_t: string, c?: unknown) => { contents.push(c); return Promise.resolve(ok()); } };
  const m = mk({ asn_relay_push_recipient_node: { user: USER }, asn_relay_push_targets: { targets: [{ node: "flood1", token: TOK }] }, asn_relay_push_node_name: { name: "工作機" } });
  await notifyPush({ rpc: m.rpc, fcm }, "confirm", "wrk9b2", "req-flood-1");
  await notifyPush({ rpc: m.rpc, fcm }, "confirm", "wrk9b2", "req-flood-2");
  assertEquals(contents.length, 1, "10 秒內第二個請求不再推同一台");
  const m2 = mk({ asn_relay_push_recipient_node: { user: USER }, asn_relay_push_targets: { targets: [{ node: "flood2", token: TOK2 }] }, asn_relay_push_node_name: { name: "工作機" } });
  await notifyPush({ rpc: m2.rpc, fcm }, "confirm", "wrk9b2", "req-flood-3");
  assertEquals(contents.length, 2, "另一台照樣推");
  assertEquals(CONFIRM_GAP_MS, 10_000);
});

Deno.test("需要你確認：收件人＝節點擁有者、targets 用 confirm、通知帶清理過的電腦名", async () => {
  const m = mk({ asn_relay_push_recipient_node: { user: USER }, asn_relay_push_targets: { targets: [{ node: "phn1a1", token: TOK }] }, asn_relay_push_node_name: { name: "工作\u202E機" } });
  const contents: unknown[] = [];
  const fcm: Fcm = { send: (_t, c) => { contents.push(c); return Promise.resolve(ok()); } };
  await notifyPush({ rpc: m.rpc, fcm }, "confirm", "wrk9b2", "req-0001");
  assertEquals(m.calls[0], { fn: "asn_relay_push_recipient_node", args: { p_node: "wrk9b2" } });
  assertEquals(m.calls[1], { fn: "asn_relay_push_targets", args: { p_user: USER, p_kind: "confirm" } });
  assertEquals(m.calls[2], { fn: "asn_relay_push_node_name", args: { p_node: "wrk9b2" } });
  assertEquals(contents, [{ kind: "confirm", name: "工作 機" }]);
});

Deno.test("需要你確認：同一筆請求不會推兩次；沒有請求編號不推；名字查不到照推（沒名字版）", async () => {
  // 每台 10 秒防洪是整個模組共用：每支測試用不同的手機節點
  const ans = { asn_relay_push_recipient_node: { user: USER }, asn_relay_push_targets: { targets: [{ node: "phn3c3", token: TOK }] }, asn_relay_push_node_name: { data: null, error: { message: "x" } } };
  const m = mk(ans);
  const contents: unknown[] = [];
  const fcm: Fcm = { send: (_t, c) => { contents.push(c); return Promise.resolve(ok()); } };
  await notifyPush({ rpc: m.rpc, fcm }, "confirm", "wrk9b2", "req-dup-1");
  await notifyPush({ rpc: m.rpc, fcm }, "confirm", "wrk9b2", "req-dup-1");
  await notifyPush({ rpc: m.rpc, fcm }, "confirm", "wrk9b2", null);
  assertEquals(contents, [{ kind: "confirm", name: null }]);
});

Deno.test("需要你確認：沒有目標就不查名字；owner_mail／waiting 不帶內容", async () => {
  const m = mk({ asn_relay_push_recipient_node: { user: USER }, asn_relay_push_targets: { targets: [] } });
  await notifyPush({ rpc: m.rpc, fcm: fcmReturning(ok()).fcm }, "confirm", "wrk9b2", "req-none-1");
  assertEquals(m.calls.some((c) => c.fn === "asn_relay_push_node_name"), false);
  const w = mk({ asn_relay_push_recipient_node: { user: USER }, asn_relay_push_targets: { targets: [{ node: "phn1a1", token: TOK }] } });
  const contents: unknown[] = [];
  await notifyPush({ rpc: w.rpc, fcm: { send: (_t, c) => { contents.push(c); return Promise.resolve(ok()); } } }, "waiting", "wrk9b2", null);
  assertEquals(contents, [undefined]);
  assertEquals(w.calls.some((c) => c.fn === "asn_relay_push_node_name"), false);
});
