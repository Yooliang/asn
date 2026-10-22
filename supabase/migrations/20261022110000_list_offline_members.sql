-- #167：離線的成員也要列在名單上（手機新裝沒有本機記憶，節點離線後整個成員就消失）。
-- 資料來源：relay.roster。節點每次回報才會整份刪除重插，節點不再回報時最後一次的列會留著，
--   所以「seen_at 在 30 天內、但超過 3 分鐘沒更新」的列就是離線成員（不必動回報函式、不必另開表）。
-- 相容：舊用戶端把 agents 每一列都當在線，所以離線成員另放在新欄位 offline_agents（形狀同 agents，
--   online=false、status='offline'）；agents 維持只有 3 分鐘內的列，只多一個 online=true。
-- 其餘（節點欄位、partner_id、detail、asn）與 20261022060000 完全相同。
begin;

create or replace function public.irori_relay_list(p_tenant uuid)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id, 'name', n.name, 'kind', n.kind, 'machine', n.machine,
    'online', coalesce(n.last_seen_at > now() - interval '3 minutes', false),
    'presence', case when n.last_seen_at > now() - interval '3 minutes' then 'live'
                     when n.last_seen_at > now() - interval '24 hours' then 'recent' else 'idle' end,
    'last_seen_at', n.last_seen_at,
    'avatar_updated_at', case when n.avatar is null then null else n.avatar_updated_at end,
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', r.status, 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail,
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'online', true) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at > now() - interval '3 minutes'
    ), '[]'::jsonb),
    'offline_agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', 'offline', 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail,
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'online', false,
        'last_seen_at', r.seen_at) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at <= now() - interval '3 minutes' and r.seen_at > now() - interval '30 days'
    ), '[]'::jsonb),
    'asn', coalesce((
      select jsonb_agg(jsonb_build_object('window_name', p.window_name, 'version', p.version, 'status', p.status, 'psm', p.psm, 'updated_at', p.updated_at) order by p.window_name)
      from relay.asn_presence p where p.node = n.id and p.updated_at > now() - interval '3 minutes'
    ), '[]'::jsonb)) order by n.id), '[]'::jsonb)
  from relay.nodes n where n.status = 'active' and n.tenant_id is not distinct from p_tenant;
$function$;

revoke all on function public.irori_relay_list(uuid) from public, anon, authenticated;
grant execute on function public.irori_relay_list(uuid) to service_role;

commit;
