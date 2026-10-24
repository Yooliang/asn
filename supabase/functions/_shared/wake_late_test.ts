// 晚到的叫醒順序補上：後台 room_read 多回的 wakes 原樣帶給用戶端（選填，舊後台沒有就不附）。
// 執行：SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno test -A supabase/functions/_shared/wake_late_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { handleNodeRoomAction, type RoomDeps } from "./rooms.ts";

const ME = { id: "w02" };
function fake(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const deps: RoomDeps = {
    rpc: (fn, args) => { calls.push({ fn, args }); const h = handlers[fn]; return Promise.resolve({ data: h ? h(args) : {}, error: null }); },
    ring: () => Promise.resolve(),
    rosterHas: () => Promise.resolve(true),
  };
  return { deps, calls };
}

Deno.test("room_read：wakes 原樣帶給用戶端；只補問（沒有新訊息）時不叫排序模型、不寫回；舊後台沒有就不附", async () => {
  const wakes = [{ seq: 2, wake_info: [{ key: "w02", label: "W02", rank: 1, hold: false }, { key: "aegis", label: "牧陽", rank: 2, hold: false }] }];
  let scored = 0;
  const { deps, calls } = fake({
    asn_relay_room_read: () => ({ key: "~u:abc", last_seq: 2, messages: [], reads: [], wakes }),
  });
  deps.rank = { cfg: { min: 0.5, exemptMentioned: true }, score: () => { scored++; return Promise.resolve(null); } } as unknown as RoomDeps["rank"];
  const r = await handleNodeRoomAction(deps, ME, "room_read", { room: "r1", since: "2", limit: "1", mark: "0" });
  assertEquals((r.body as { wakes?: unknown }).wakes, wakes);
  assertEquals((r.body as { reads?: unknown }).reads, []);
  assertEquals(scored, 0);
  assertEquals(calls.some((c) => c.fn === "asn_relay_room_wake_set"), false);
  const old = fake({ asn_relay_room_read: () => ({ key: "w02", last_seq: 1, messages: [] }) });
  const r2 = await handleNodeRoomAction(old.deps, ME, "room_read", { room: "r1", since: "0" });
  assertEquals("wakes" in (r2.body as object), false);
});

Deno.test("room_read：wakes 不是陣列（壞資料）不附", async () => {
  const { deps } = fake({ asn_relay_room_read: () => ({ key: "w02", last_seq: 1, messages: [], wakes: "壞的" }) });
  const r = await handleNodeRoomAction(deps, ME, "room_read", { room: "r1", since: "0" });
  assertEquals("wakes" in (r.body as object), false);
});
