-- 封存後仍留在名單上的修正。
-- 根因：封存只標在「線上名單（relay.roster）有的成員」上；夥伴早已不在名單回報裡（離線超過 30 天或名單已清掉）時，
--   後台名單根本不列它，但用戶端本機存檔記得它（有往來記錄的舊好友），照樣列出來、又沒有 archived 旗標，所以封存了還在。
-- 修正（後台部分，只動 asn_relay_list，以 20261023090000 的定義為基礎）：
--  1. 每台電腦多帶 archived_keys：該租戶在這個節點上所有封存的鍵（夥伴 ID 或 n:節點/名字），用戶端用兩種鍵比對本機舊好友。
--  2. 成員的 archived 旗標：夥伴 ID 或 n:節點/名字，任一種鍵命中就算（原本只認夥伴 ID，有夥伴記錄就不看 n: 鍵）。
-- 相容：只多一個鍵；舊用戶端略過。舊名的名單函式是薄包裝，會自動呼叫新名，不必動。
-- 先不套用。部署順序：migration → 發新版 ASN（舊版用戶端不受影響；新版用戶端遇到舊後台沒有 archived_keys＝照舊）。
begin;

create or replace function public.asn_relay_list(p_tenant uuid)
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
    'claude_mod', case when n.claude_mod is null then null else n.claude_mod || jsonb_build_object('updated_at', n.claude_mod_at) end,
    'avatar_updated_at', case when n.avatar is null then null else n.avatar_updated_at end,
    'archived_keys', coalesce((select jsonb_agg(a.key order by a.key) from relay.partner_archives a
                                where a.tenant_id is not distinct from p_tenant and a.node = n.id), '[]'::jsonb),
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', r.status, 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail, 'context_pct', r.context_pct, 'mod_loaded', r.mod_loaded,
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'online', true,
        'archived', exists (select 1 from relay.partner_archives a where a.tenant_id is not distinct from p_tenant
                              and (a.key = 'n:' || n.id || '/' || r.name
                                   or a.key = (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name)))) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at > now() - interval '3 minutes'
    ), '[]'::jsonb),
    'offline_agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', 'offline', 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail, 'context_pct', r.context_pct, 'mod_loaded', r.mod_loaded,
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'online', false,
        'last_seen_at', r.seen_at,
        'archived', exists (select 1 from relay.partner_archives a where a.tenant_id is not distinct from p_tenant
                              and (a.key = 'n:' || n.id || '/' || r.name
                                   or a.key = (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name)))) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at <= now() - interval '3 minutes' and r.seen_at > now() - interval '30 days'
    ), '[]'::jsonb),
    'asn', coalesce((
      select jsonb_agg(jsonb_build_object('window_name', p.window_name, 'version', p.version, 'status', p.status, 'psm', p.psm, 'updated_at', p.updated_at) order by p.window_name)
      from relay.asn_presence p where p.node = n.id and p.updated_at > now() - interval '3 minutes'
    ), '[]'::jsonb)) order by n.id), '[]'::jsonb)
  from relay.nodes n where n.status = 'active' and n.tenant_id is not distinct from p_tenant;
$function$;
revoke all on function public.asn_relay_list(uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_list(uuid) to service_role;

commit;
