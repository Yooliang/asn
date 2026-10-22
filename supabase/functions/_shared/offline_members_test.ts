import { assert } from "jsr:@std/assert@1";

// #167：list 也回離線（30 天內）的成員，放在 offline_agents；agents 與其他欄位照舊
const sql = Deno.readTextFileSync(new URL("../../migrations/20261022110000_list_offline_members.sql", import.meta.url)).replace(/\r\n/g, "\n");

Deno.test("offline members migration：離線 30 天內列入 offline_agents、標 offline／online=false", () => {
  assert(sql.includes("'offline_agents'"), "要有 offline_agents");
  assert(sql.includes("r.seen_at <= now() - interval '3 minutes' and r.seen_at > now() - interval '30 days'"), "離線＝超過 3 分鐘且 30 天內");
  assert(sql.includes("'status', 'offline'") && sql.includes("'online', false"), "離線列標 offline、online=false");
});

Deno.test("offline members migration：agents 仍只有 3 分鐘內且 online=true，其餘欄位保留", () => {
  assert(sql.includes("'online', true) order by r.name)\n      from relay.roster r where r.node = n.id and r.seen_at > now() - interval '3 minutes'"), "agents 只收 3 分鐘內");
  for (const k of ["'partner_id'", "'detail', r.detail", "relay.asn_presence p", "'avatar_updated_at'", "'presence'"]) assert(sql.includes(k), `要保留 ${k}`);
  assert(sql.includes("grant execute on function public.irori_relay_list(uuid) to service_role;"), "授權保留");
});
