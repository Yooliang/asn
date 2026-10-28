// 最後活動時間的 Edge 端（last_active.ts）：節點用呼叫端給的、夥伴名字限長、背景優先、沒有背景時最多等 1 秒、失敗與逾時不丟錯。
import { assert, assertEquals } from "jsr:@std/assert@1";
import { roomPostAgent, touchActive, type TouchRpc } from "./last_active.ts";

function mk(reply: () => Promise<{ data?: unknown; error?: unknown }>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: TouchRpc = (fn, args) => { calls.push({ fn, args }); return reply(); };
  return { rpc, calls };
}
const ok = () => Promise.resolve({ data: { node: 1, partner: 1 }, error: null });

Deno.test("寫入：節點是呼叫端給的、夥伴名字原樣帶、函式固定是 asn_relay_touch_active", async () => {
  const { rpc, calls } = mk(ok);
  await touchActive(rpc, "H", "小文", { waitUntil: null });
  assertEquals(calls, [{ fn: "asn_relay_touch_active", args: { p_node: "H", p_agent: "小文" } }]);
});

Deno.test("沒有夥伴名字、名字太長：只帶節點（p_agent 是 null）", async () => {
  const { rpc, calls } = mk(ok);
  await touchActive(rpc, "H", null, { waitUntil: null });
  await touchActive(rpc, "H", "", { waitUntil: null });
  await touchActive(rpc, "H", "字".repeat(101), { waitUntil: null });
  assertEquals(calls.map((c) => c.args.p_agent), [null, null, null]);
});

Deno.test("有 waitUntil：丟到背景就回來，不等寫入做完", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const { rpc } = mk(async () => { await gate; return { data: {}, error: null }; });
  let bg: Promise<unknown> | null = null;
  await touchActive(rpc, "H", "a", { waitUntil: (p) => { bg = p; } });
  assert(bg !== null, "有交給背景");
  release();
  await bg;
});

Deno.test("沒有 waitUntil：最多等 1 秒（這裡用 30 毫秒），逾時只記 log、不丟錯", async () => {
  const logs: string[] = [];
  const { rpc } = mk(() => new Promise(() => {}));   // 永遠不回
  const t0 = Date.now();
  await touchActive(rpc, "H", "a", { waitUntil: null, timeoutMs: 30, log: (m) => logs.push(m) });
  assert(Date.now() - t0 < 500, "沒有卡住");
  assertEquals(logs.length, 1);
  assert(logs[0].includes("逾時"));
});

Deno.test("資料庫回錯誤、函式不存在（舊後台）、呼叫丟例外：都只記 log，不丟錯", async () => {
  for (const reply of [
    () => Promise.resolve({ data: null, error: { message: "function does not exist" } }),
    () => Promise.reject(new Error("boom")),
  ]) {
    const logs: string[] = [];
    const { rpc } = mk(reply);
    await touchActive(rpc, "H", "a", { waitUntil: null, log: (m) => logs.push(m) });
    assertEquals(logs.length, 1);
    assert(!logs[0].includes("boom") && !logs[0].includes("does not exist"), "log 不帶資料庫細節");
  }
});

Deno.test("群組發言的寄件視窗名：as_agent 優先，其次 from_agent，都沒有是 null", () => {
  assertEquals(roomPostAgent({ as_agent: "甲", from_agent: "乙" }), "甲");
  assertEquals(roomPostAgent({ from_agent: "乙" }), "乙");
  assertEquals(roomPostAgent({ as_agent: "", from_agent: 5 }), null);
  assertEquals(roomPostAgent({}), null);
});

Deno.test("接線：send 與 room_post 成功後都呼叫，節點用 me.id", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  assert(src.includes("await touchActive(rpc, me.id, str(b.from_agent))"));
  assert(src.includes('if (action === "room_post" && r.status === 200) await touchActive(rpc, me.id, roomPostAgent(params))'));
  assert(!src.includes("touchActive(rpc, b.") && !src.includes("touchActive(rpc, params."), "節點不從請求內容取");
});
