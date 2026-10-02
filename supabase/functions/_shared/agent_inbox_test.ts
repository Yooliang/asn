// 執行：SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno test -A supabase/functions/
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type AgentInboxDeps, handleAgentInbox, parseAgentName } from "./agent_inbox.ts";

const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
type Row = { id: string; to_node: string; to_agent: string | null; acked: boolean };

// 照 08_agent_inbox.sql 的語意做的記憶體假資料庫（to_node 與 to_agent 精確相等；null 不等於任何字串）
function fakeDb(rows: Row[]) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const deps: AgentInboxDeps = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      if (fn === "irori_relay_inbox_agent") {
        return Promise.resolve({ data: rows.filter((r) => r.to_node === args.p_node && r.to_agent === args.p_agent && !r.acked).map((r) => ({ id: r.id, to_agent: r.to_agent })), error: null });
      }
      if (fn === "irori_relay_ack_agent") {
        let n = 0;
        for (const r of rows) {
          if (r.to_node === args.p_node && r.to_agent === args.p_agent && (args.p_ids as string[]).includes(r.id) && !r.acked) { r.acked = true; n++; }
        }
        return Promise.resolve({ data: n, error: null });
      }
      return Promise.resolve({ data: null, error: "unknown fn" });
    },
  };
  return { deps, calls };
}
const seed = (): Row[] => [
  { id: U(1), to_node: "H", to_agent: "H-甲", acked: false },
  { id: U(2), to_node: "H", to_agent: "H-乙", acked: false },
  { id: U(3), to_node: "H", to_agent: null, acked: false },   // 總機信
  { id: U(4), to_node: "X", to_agent: "H-甲", acked: false },  // 別的節點同名視窗
];

Deno.test("inbox agent=：只回寄給該視窗的信，不含別的視窗、總機信、別的節點", async () => {
  const { deps } = fakeDb(seed());
  const r = await handleAgentInbox(deps, { id: "H" }, "inbox", "H-甲");
  assertEquals(r.status, 200);
  assertEquals((r.body as { messages: { id: string }[] }).messages.map((m) => m.id), [U(1)]);
});

Deno.test("ack agent=：A 視窗 ack 不到 B 視窗的信，也 ack 不到總機信與別節點的信", async () => {
  const rows = seed();
  const { deps } = fakeDb(rows);
  const r = await handleAgentInbox(deps, { id: "H" }, "ack", "H-甲", { ids: [U(1), U(2), U(3), U(4)] });
  assertEquals(r.status, 200);
  assertEquals((r.body as { acked: number }).acked, 1);
  assertEquals(rows.map((x) => x.acked), [true, false, false, false]);
});

Deno.test("節點一律取自金鑰（me.id），agent 參數改不了節點", async () => {
  const { deps, calls } = fakeDb(seed());
  await handleAgentInbox(deps, { id: "H" }, "inbox", "H-甲");
  await handleAgentInbox(deps, { id: "H" }, "ack", "H-甲", { ids: [U(1)] });
  assertEquals(calls.map((c) => [c.fn, c.args.p_node, c.args.p_agent]), [["irori_relay_inbox_agent", "H", "H-甲"], ["irori_relay_ack_agent", "H", "H-甲"]]);
});

Deno.test("agent 空白或格式不對 → 400，不碰資料庫（不會退化成整個節點信箱）", async () => {
  const { deps, calls } = fakeDb(seed());
  for (const bad of ["", null, undefined, " H-甲", "H-甲 ", "a\nb", "x".repeat(101), 5]) {
    assertEquals((await handleAgentInbox(deps, { id: "H" }, "inbox", bad)).status, 400, String(bad));
    assertEquals((await handleAgentInbox(deps, { id: "H" }, "ack", bad, { ids: [U(1)] })).status, 400, String(bad));
  }
  assertEquals(calls.length, 0);
  assertEquals(parseAgentName("H-工頭-2"), "H-工頭-2");
});

Deno.test("ack 的 ids 格式：非 uuid、超過 100 個、不是陣列都 400", async () => {
  const { deps, calls } = fakeDb(seed());
  for (const b of [{ ids: ["x"] }, { ids: Array(101).fill(U(1)) }, { ids: "a" }, null, {}]) {
    assertEquals((await handleAgentInbox(deps, { id: "H" }, "ack", "H-甲", b)).status, 400);
  }
  assertEquals(calls.length, 0);
});

// 守門：隔離的真正執行者是 SQL；SQL 檔裡兩支函式都必須用 to_agent = p_agent 精確比對（拿掉就紅）
Deno.test("08_agent_inbox.sql：inbox 與 ack 都有 to_node = p_node 且 to_agent = p_agent，且不碰 to_agent is null", async () => {
  const sql = await Deno.readTextFile(new URL("../../sql/08_agent_inbox.sql", import.meta.url));
  const fn = (name: string) => {
    const i = sql.indexOf(`function public.${name}(`);
    assert(i >= 0, name);
    return sql.slice(i, sql.indexOf("$$;", sql.indexOf("as $$", i)));
  };
  for (const name of ["irori_relay_inbox_agent", "irori_relay_ack_agent"]) {
    const body = fn(name);
    assert(/to_node = p_node and (m\.)?to_agent = p_agent/.test(body), `${name} 缺 to_node = p_node and to_agent = p_agent`);
    assert(!/to_agent is null|coalesce\(to_agent|or to_agent/i.test(body), `${name} 不可放行 to_agent 為空`);
  }
});
