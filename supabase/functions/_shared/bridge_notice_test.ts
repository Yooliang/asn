// 通知集中 PR-D（#848）：relay?action=bridge_notice 的參數只收 reply_to 與 body，錯誤碼對照，寄出後敲門鈴、扇出才推播
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleBridgeNotice, parseBridgeNotice } from "./bridge_notice.ts";

const ID = "11111111-2222-4333-8444-555555555555";

function deps(data: unknown, error: unknown = null) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rings: string[] = [];
  return {
    calls, rings,
    d: {
      rpc: (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return Promise.resolve({ data, error });
      },
      ring: (t: string) => { rings.push(t); return Promise.resolve(); },
    },
  };
}

Deno.test("參數：只收 reply_to（uuid）與 body（1～20000 字）", () => {
  assertEquals(parseBridgeNotice({ reply_to: ID, body: "x" }), { replyTo: ID, body: "x" });
  for (const bad of [null, [], "x", { reply_to: "nope", body: "x" }, { reply_to: ID }, { reply_to: ID, body: "" }, { reply_to: ID, body: "x".repeat(20001) }, { body: "x" }]) {
    assertEquals(parseBridgeNotice(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
});

Deno.test("收件人、寄件名、kind 由用戶端帶來也不會傳進資料庫", async () => {
  const t = deps({ ok: true, notify: "sent", id: ID, bell_topics: ["b1"] });
  const r = await handleBridgeNotice(t.d, "N", { reply_to: ID, body: "內文", to_node: "X", to_agent: "Y", from_agent: "ASN 通知", kind: "notice:login", p_kind: "x" });
  assertEquals(r.status, 200);
  assertEquals(t.calls, [{ fn: "asn_relay_send_bridge_notice", args: { p_node: "N", p_reply_to: ID, p_body: "內文" } }]);
});

Deno.test("寄出：敲每個門鈴（去重）；不推播（扇出給本人也不推，FCM 第一版只推寄給本人和夥伴在等你）", async () => {
  const t = deps({ ok: true, notify: "sent", id: ID, bell_topics: ["b1", "b1", "b2", "", 3], fanout: 2 });
  const r = await handleBridgeNotice(t.d, "N", { reply_to: ID, body: "x" });
  assertEquals(r, { status: 200, body: { ok: true, notify: "sent", id: ID } });
  assertEquals(t.rings, ["b1", "b2"]);
  const src = Deno.readTextFileSync(new URL("./bridge_notice.ts", import.meta.url)).replace(/^\s*\/\/.*$/gm, "");
  assert(!/push/i.test(src), "橋通知不推播");
});

Deno.test("沒寄出（限流、每封上限、失敗）：200 照實回 notify，不敲門鈴不推播", async () => {
  for (const notify of ["rate_limited", "per_mail_limit", "failed"]) {
    const t = deps({ ok: true, notify, bell_topics: [] });
    const r = await handleBridgeNotice(t.d, "N", { reply_to: ID, body: "x" });
    assertEquals(r, { status: 200, body: { ok: true, notify } });
    assertEquals(t.rings.length, 0);
  }
});

Deno.test("錯誤碼：跨帳號 409（橋照舊寄）、找不到原信或原信是通知 422、權限 403、壞參數 400、資料庫錯 500", async () => {
  const cases: [unknown, unknown, number, string][] = [
    [{ error: "cross_account" }, null, 409, "cross_account"],
    [{ error: "no_origin" }, null, 422, "no_origin"],
    [{ error: "is_notice" }, null, 422, "is_notice"],
    [{ error: "forbidden" }, null, 403, "forbidden"],
    [{ error: "bad_body" }, null, 400, "bad_body"],
    [{ error: "怪的" }, null, 400, "bad_request"],
    [null, { message: "boom" }, 500, "internal"],
  ];
  for (const [data, err, status, code] of cases) {
    const t = deps(data, err);
    const r = await handleBridgeNotice(t.d, "N", { reply_to: ID, body: "x" });
    assertEquals([r.status, r.body.error], [status, code], code);
    assertEquals(t.rings.length, 0);
  }
  const bad = deps({});
  assertEquals((await handleBridgeNotice(bad.d, "N", { body: "x" })).status, 400);
  assertEquals(bad.calls.length, 0, "參數不對不呼叫資料庫");
});

Deno.test("守門：relay 的 bridge_notice 用金鑰所屬的節點，不看用戶端帶的節點", () => {
  const src = Deno.readTextFileSync(new URL("../relay/index.ts", import.meta.url)).replace(/\r\n/g, "\n");
  const i = src.indexOf('if (action === "bridge_notice" && req.method === "POST") {');
  assert(i >= 0);
  const blk = src.slice(i, src.indexOf("\n  }\n", i));
  assert(blk.includes("}, me.id, await req.json()"), "節點一律是 me.id");
  assert(!blk.includes("asn_relay_send"), "不直接寄信");
});
