// #2161 第 3d-1 段：手機決定權限框／終端確認成功後，敲「擁有該請求那台電腦」的門鈴。
// 重點：topic 正確、payload 只有 kind（絕不帶 node：舊客戶端 kind＋node 都有才算回報門鈴）、回給手機的內容不含 bell_topic、失敗與舊資料庫（沒回 bell_topic）不敲。
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handlePermReqAction, type PermReqDeps } from "./perm_request.ts";
import { handleTermReqAction, type TermReqDeps } from "./term_request.ts";

const H = "a".repeat(64);
const ID = "11111111-2222-3333-4444-555555555555";
const TOPIC = "bell-w1-secret";
type Ring = { topic: string; payload?: Record<string, unknown> };
const mk = (reply: Record<string, unknown>) => {
  const rung: Ring[] = [];
  const deps: PermReqDeps & TermReqDeps = {
    rpc: () => Promise.resolve({ data: reply, error: null }),
    ring: (topic, payload) => { rung.push({ topic, payload }); return Promise.resolve(); },
  };
  return { deps, rung };
};
const permDecide = (m: ReturnType<typeof mk>) => handlePermReqAction(m.deps, { id: "P" }, "perm_req_decide", { id: ID, choice_n: 1, hash: H }, "U1");
const termDecide = (m: ReturnType<typeof mk>, decision: string) => handleTermReqAction(m.deps, { id: "P" }, "term_req_decide", { id: ID, decision, hash: H }, "U1");

Deno.test("權限框決定：敲該電腦的門鈴一次，payload 只有 kind、沒有 node，回應不含 bell_topic", async () => {
  const m = mk({ ok: true, status: "decided", bell_topic: TOPIC });
  const r = await permDecide(m);
  assertEquals(r, { status: 200, body: { ok: true, status: "decided" } });
  assertEquals(m.rung.length, 1);
  assertEquals(m.rung[0].topic, TOPIC);
  assertEquals(m.rung[0].payload, { kind: "perm_req" });
  assert(!("node" in (m.rung[0].payload ?? {})));
  assert(!JSON.stringify(r).includes(TOPIC));
});

Deno.test("權限框決定：失敗不敲；後台沒給 bell_topic（舊資料庫）或是 null 不敲也不炸", async () => {
  for (const code of ["hash_mismatch", "not_found", "bad_choice", "forbidden"]) {
    const m = mk({ error: code, bell_topic: TOPIC });
    assert((await permDecide(m)).status !== 200, code);
    assertEquals(m.rung.length, 0, code);
  }
  for (const reply of [{ ok: true, status: "decided" }, { ok: true, status: "decided", bell_topic: null }]) {
    const m = mk(reply);
    assertEquals((await permDecide(m)).body, { ok: true, status: "decided" });
    assertEquals(m.rung.length, 0);
  }
  const bad = mk({ ok: true, status: "decided", bell_topic: TOPIC });
  assertEquals((await handlePermReqAction(bad.deps, { id: "P" }, "perm_req_decide", { id: "x", choice_n: 1, hash: H }, "U1")).status, 400);
  assertEquals((await handlePermReqAction(bad.deps, { id: "P" }, "perm_req_decide", { id: ID, choice_n: 1, hash: H }, null)).status, 403);
  assertEquals(bad.rung.length, 0, "壞參數、沒簽章都不敲");
});

Deno.test("終端確認決定：approve 與 deny 都敲、payload 只有 kind、回應不含 bell_topic", async () => {
  for (const [decision, status] of [["approve", "approved"], ["deny", "denied"]]) {
    const m = mk({ ok: true, status, bell_topic: TOPIC });
    const r = await termDecide(m, decision);
    assertEquals(r, { status: 200, body: { ok: true, status } }, decision);
    assertEquals(m.rung.length, 1, decision);
    assertEquals(m.rung[0].topic, TOPIC);
    assertEquals(m.rung[0].payload, { kind: "term_req" });
    assert(!("node" in (m.rung[0].payload ?? {})));
    assert(!JSON.stringify(r).includes(TOPIC));
  }
});

Deno.test("終端確認決定：失敗不敲；沒給 bell_topic 或是 null 不敲也不炸", async () => {
  for (const code of ["hash_mismatch", "not_found", "bad_choice", "forbidden"]) {
    const m = mk({ error: code, bell_topic: TOPIC });
    assert((await termDecide(m, "approve")).status !== 200, code);
    assertEquals(m.rung.length, 0, code);
  }
  for (const reply of [{ ok: true, status: "approved" }, { ok: true, status: "approved", bell_topic: null }]) {
    const m = mk(reply);
    assertEquals((await termDecide(m, "approve")).body, { ok: true, status: "approved" });
    assertEquals(m.rung.length, 0);
  }
});
