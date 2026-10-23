import { assert, assertEquals } from "jsr:@std/assert@1";
import { rosterBellTopics } from "./roster.ts";

const sql = Deno.readTextFileSync(new URL("../../migrations/20261023120000_roster_push.sql", import.meta.url));
const index = Deno.readTextFileSync(new URL("../relay/index.ts", import.meta.url));

Deno.test("名單門鈴：只收字串陣列、去重、舊資料庫沒鍵就空", () => {
  assertEquals(rosterBellTopics({ count: 1 }), []);
  assertEquals(rosterBellTopics(null), []);
  assertEquals(rosterBellTopics({ bell_topics: "x" }), []);
  assertEquals(rosterBellTopics({ bell_topics: ["a", "a", 3, "", "b"] }), ["a", "b"]);
  assertEquals(rosterBellTopics({ bell_topics: Array.from({ length: 30 }, (_, i) => "t" + i) }).length, 20);
});

Deno.test("名單推播 migration：只用 asn_relay_ 名稱、判斷有變、2 秒限流、只授權 service_role、保留舊檢查", () => {
  assert(/create or replace function public\.asn_relay_roster\(p_node text, p_agents jsonb\)/i.test(sql));
  assert(!/irori_relay_/.test(sql));
  assert(/roster_bell_at < now\(\) - interval '2 seconds'/.test(sql));
  assert(/v_old is distinct from v_new/.test(sql));
  assert(/o\.tenant_id is not distinct from v_tenant/.test(sql));
  assert(/'count', v_n, 'changed', v_changed, 'bell_topics', v_topics/.test(sql));
  assert(/\(can_invite or can_roster\)/.test(sql) && /mod_loaded/.test(sql));
  assert(!/grant execute[^;]*to (anon|authenticated|public)/.test(sql));
});

Deno.test("relay Edge Function：名單回報成功後才敲門鈴，且在回應之前", () => {
  const i = index.indexOf('db.rpc("asn_relay_roster"');
  const j = index.indexOf("rosterBellTopics(data)");
  const k = index.indexOf("return json(200, { ok: true, count: data.count })");
  assert(i > 0 && j > i && k > j);
});
