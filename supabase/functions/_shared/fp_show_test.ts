// 手機請電腦顯示指紋（#1863）：參數檢查、簽章要求、門鈴（只敲目標電腦、payload 只有 kind）、回給手機的內容不含門鈴頻道。
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FP_SHOW_ACTIONS, FP_SHOW_SIGNED_ACTIONS, type FpShowDeps, handleFpShowAction } from "./fp_show.ts";

const ID = "11111111-2222-3333-4444-555555555555";
const TOPIC = "bell-w1-secret";
type Ring = { topic: string; payload?: Record<string, unknown> };
const mk = (reply: Record<string, unknown> = {}, error: unknown = null) => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rung: Ring[] = [];
  const deps: FpShowDeps = {
    rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve({ data: reply, error }); },
    ring: (topic, payload) => { rung.push({ topic, payload }); return Promise.resolve(); },
  };
  return { deps, calls, rung };
};
const phone = { id: "phn7a1" };
const pc = { id: "wrk9b2" };

Deno.test("動作分類：三個要簽章（手機），兩個用節點金鑰（電腦）", () => {
  assertEquals([...FP_SHOW_ACTIONS].sort(), ["fp_show_ack", "fp_show_end", "fp_show_request", "fp_show_status", "fp_show_take"]);
  assertEquals([...FP_SHOW_SIGNED_ACTIONS].sort(), ["fp_show_end", "fp_show_request", "fp_show_status"]);
});

Deno.test("請求：敲目標電腦的門鈴一次、payload 只有 kind、回應不含門鈴頻道", async () => {
  const m = mk({ id: ID, expires_at: "t", bell_topic: TOPIC });
  const r = await handleFpShowAction(m.deps, phone, "fp_show_request", { node: "wrk9b2" }, "U1");
  assertEquals(r, { status: 200, body: { id: ID, expires_at: "t" } });
  assertEquals(m.calls[0], { fn: "asn_relay_fp_show_request", args: { p_actor: "phn7a1", p_signed_user: "U1", p_target: "wrk9b2" } });
  assertEquals(m.rung, [{ topic: TOPIC, payload: { kind: "fp_show" } }]);
  assert(!("node" in (m.rung[0].payload ?? {})));
  assert(!JSON.stringify(r).includes(TOPIC));
});

Deno.test("請求：沒簽章 403、壞參數 400，都不呼叫資料庫也不敲", async () => {
  const m = mk({ id: ID, bell_topic: TOPIC });
  assertEquals((await handleFpShowAction(m.deps, phone, "fp_show_request", { node: "wrk9b2" }, null)).status, 403);
  for (const bad of [{}, { node: "" }, { node: 5 }, { node: "a b" }, { node: "x".repeat(33) }, { node: "a/../b" }]) {
    assertEquals((await handleFpShowAction(m.deps, phone, "fp_show_request", bad, "U1")).status, 400, JSON.stringify(bad));
  }
  assertEquals(m.calls.length, 0);
  assertEquals(m.rung.length, 0);
});

Deno.test("請求：資料庫拒絕（非本人、太頻繁）就照碼回、不敲門鈴", async () => {
  for (const [code, status] of [["forbidden", 403], ["rate_limited", 429], ["not_found", 404], ["bad_request", 400]] as const) {
    const m = mk({ error: code, bell_topic: TOPIC });
    assertEquals((await handleFpShowAction(m.deps, phone, "fp_show_request", { node: "wrk9b2" }, "U1")).status, status, code);
    assertEquals(m.rung.length, 0, code);
  }
  const boom = mk({}, { message: "db down" });
  assert((await handleFpShowAction(boom.deps, phone, "fp_show_request", { node: "wrk9b2" }, "U1")).status !== 200, "資料庫出錯不能當成功");
  assertEquals(boom.rung.length, 0);
});

Deno.test("請求與結束：門鈴失敗吞掉，照樣回成功與編號", async () => {
  const mkRingFail = (reply: Record<string, unknown>) => {
    const m = mk(reply);
    m.deps.ring = () => Promise.reject(new Error("realtime down"));
    return m;
  };
  const m = mkRingFail({ id: ID, expires_at: "t", bell_topic: TOPIC });
  assertEquals(await handleFpShowAction(m.deps, phone, "fp_show_request", { node: "wrk9b2" }, "U1"), { status: 200, body: { id: ID, expires_at: "t" } });
  const e = mkRingFail({ ok: true, status: "ended", bell_topic: TOPIC });
  assertEquals(await handleFpShowAction(e.deps, phone, "fp_show_end", { id: ID }, "U1"), { status: 200, body: { ok: true, status: "ended" } });
});

Deno.test("請求：太頻繁時帶回同一人進行中那筆的編號（放在 scope）；沒編號或格式不對就不帶", async () => {
  const m = mk({ error: "rate_limited", id: ID });
  const r = await handleFpShowAction(m.deps, phone, "fp_show_request", { node: "wrk9b2" }, "U1");
  assertEquals(r.status, 429);
  assertEquals(r.body.error, "rate_limited");
  assertEquals(r.body.scope, ID);
  assertEquals(m.rung.length, 0);
  for (const reply of [{ error: "rate_limited", id: null }, { error: "rate_limited", id: "x" }, { error: "rate_limited" }, { error: "forbidden", id: ID }]) {
    const b = (await handleFpShowAction(mk(reply).deps, phone, "fp_show_request", { node: "wrk9b2" }, "U1")).body;
    assert(!("scope" in b), JSON.stringify(reply));
  }
});

Deno.test("請求：舊資料庫沒回門鈴頻道（或是 null）不敲也不炸", async () => {
  for (const reply of [{ id: ID, expires_at: "t" }, { id: ID, expires_at: "t", bell_topic: null }]) {
    const m = mk(reply);
    assertEquals((await handleFpShowAction(m.deps, phone, "fp_show_request", { node: "wrk9b2" }, "U1")).status, 200);
    assertEquals(m.rung.length, 0);
  }
});

Deno.test("狀態：要簽章、編號要是 uuid；回給手機的只有狀態欄位", async () => {
  const m = mk({ id: ID, status: "shown", detail: null, expires_at: "t", bell_topic: TOPIC, node: "wrk9b2" });
  assertEquals((await handleFpShowAction(m.deps, phone, "fp_show_status", { id: ID }, null)).status, 403);
  assertEquals((await handleFpShowAction(m.deps, phone, "fp_show_status", { id: "x" }, "U1")).status, 400);
  const r = await handleFpShowAction(m.deps, phone, "fp_show_status", { id: ID }, "U1");
  assertEquals(r, { status: 200, body: { id: ID, status: "shown", detail: null, expires_at: "t" } });
  assertEquals(m.rung.length, 0, "查狀態不敲門鈴");
});

Deno.test("結束：敲目標電腦的門鈴讓它收視窗；已結案（沒回頻道）不敲；失敗不敲", async () => {
  const m = mk({ ok: true, status: "ended", bell_topic: TOPIC });
  const r = await handleFpShowAction(m.deps, phone, "fp_show_end", { id: ID }, "U1");
  assertEquals(r, { status: 200, body: { ok: true, status: "ended" } });
  assertEquals(m.rung, [{ topic: TOPIC, payload: { kind: "fp_show" } }]);
  assert(!JSON.stringify(r).includes(TOPIC));
  const done = mk({ ok: true, status: "pc_cancelled" });
  assertEquals((await handleFpShowAction(done.deps, phone, "fp_show_end", { id: ID }, "U1")).body, { ok: true, status: "pc_cancelled" });
  assertEquals(done.rung.length, 0);
  const bad = mk({ error: "forbidden", bell_topic: TOPIC });
  assertEquals((await handleFpShowAction(bad.deps, phone, "fp_show_end", { id: ID }, "U1")).status, 403);
  assertEquals(bad.rung.length, 0);
  assertEquals((await handleFpShowAction(bad.deps, phone, "fp_show_end", { id: ID }, null)).status, 403);
  assertEquals((await handleFpShowAction(bad.deps, phone, "fp_show_end", { id: "x" }, "U1")).status, 400);
});

Deno.test("電腦領取：節點一律取自金鑰（參數裡的 node 不採用）", async () => {
  const m = mk({ requests: [{ id: ID, status: "pending" }], closed: [] });
  const r = await handleFpShowAction(m.deps, pc, "fp_show_take", { node: "someone-else", p_node: "x" }, null);
  assertEquals(r.body, { requests: [{ id: ID, status: "pending" }], closed: [] });
  assertEquals(m.calls[0], { fn: "asn_relay_fp_show_take", args: { p_node: "wrk9b2" } });
  assertEquals(m.rung.length, 0);
});

Deno.test("電腦回報：只認 shown／cancelled；節點取自金鑰；detail 截斷", async () => {
  const m = mk({ ok: true });
  for (const bad of [{}, { id: "x", status: "shown" }, { id: ID, status: "ended" }, { id: ID, status: "pending" }, { id: ID }]) {
    assertEquals((await handleFpShowAction(m.deps, pc, "fp_show_ack", bad, null)).status, 400, JSON.stringify(bad));
  }
  assertEquals(m.calls.length, 0);
  assertEquals((await handleFpShowAction(m.deps, pc, "fp_show_ack", { id: ID, status: "shown", node: "x" }, null)).body, { ok: true });
  assertEquals(m.calls[0].args, { p_node: "wrk9b2", p_id: ID, p_status: "shown", p_detail: null });
  await handleFpShowAction(m.deps, pc, "fp_show_ack", { id: ID, status: "cancelled", detail: "x".repeat(500) }, null);
  assertEquals((m.calls[1].args.p_detail as string).length, 200);
});

Deno.test("不認得的動作回 404", async () => {
  assertEquals((await handleFpShowAction(mk().deps, pc, "fp_show_nope", {}, "U1")).status, 404);
});
