-- #1875：後台名單的成員資料多帶 created_at（relay.nodes.created_at，節點建立時間），設備詳情頁辨認區才能顯示「建立時間」。
-- 只改兩支函式，各多一個 jsonb key，其餘照現行定義一個字不動（兩支都取自 20261119200000_web_sessions.sql，之後沒有別的 migration 再改過）：
--   1. relay.asn_account_nodes：成員物件多 'created_at', n.created_at。
--   2. public.asn_relay_list(uuid, boolean)：節點層多 'created_at', n.created_at（夥伴與離線夥伴不動）。
-- 舊版用戶端把名單當鬆散 JSON 讀、不認得的鍵直接略過，所以提早上這支不會壞任何一版。
-- 授權不動（create or replace 不改既有的 execute 授權）。沒有資料表變更。
-- 部署順序：只需跑這支 migration，不需改 Edge、不需發新版用戶端。
-- 回復：supabase/sql/rollback/20261120200000_nodes_created_at_down.sql（兩個函式換回上一版原文）。
begin;

create or replace function relay.asn_account_nodes(p_user uuid)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id, 'name', n.name, 'machine', n.machine, 'kind', n.kind,
    'last_seen_at', n.last_seen_at, 'created_via', n.created_via, 'created_at', n.created_at) order by n.created_at), '[]'::jsonb)
  from relay.nodes n where n.owner_user = p_user and n.status = 'active' and coalesce(n.kind, '') <> 'web';
$function$;

create or replace function public.asn_relay_list(p_tenant uuid, p_include_web boolean default false)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id, 'name', n.name, 'kind', n.kind, 'machine', n.machine,
    'online', coalesce(n.last_seen_at > now() - interval '3 minutes', false),
    'presence', case when n.last_seen_at > now() - interval '3 minutes' then 'live'
                     when n.last_seen_at > now() - interval '24 hours' then 'recent' else 'idle' end,
    'last_seen_at', n.last_seen_at,
    'created_at', n.created_at,
    'last_active_at', n.last_active_at,
    'claude_mod', case when n.claude_mod is null then null else n.claude_mod || jsonb_build_object('updated_at', n.claude_mod_at) end,
    'avatar_updated_at', case when n.avatar is null then null else n.avatar_updated_at end,
    'archived_keys', coalesce((select jsonb_agg(a.key order by a.key) from relay.partner_archives a
                                where a.tenant_id is not distinct from p_tenant and a.node = n.id), '[]'::jsonb),
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', r.status, 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail, 'context_pct', r.context_pct, 'mod_loaded', r.mod_loaded,
        'kind', r.kind, 'receivable', r.receivable, 'model', r.model, 'hidden', r.hidden, 'elevated', r.elevated,
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'online', true,
        'last_active_at', (select p.last_active_at from relay.partners p where p.node = n.id and p.current_name = r.name),
        'avatar_updated_at', (select case when p.avatar is null then null else p.avatar_updated_at end from relay.partners p where p.node = n.id and p.current_name = r.name),
        'archived', exists (select 1 from relay.partner_archives a where a.tenant_id is not distinct from p_tenant
                              and (a.key = 'n:' || n.id || '/' || r.name
                                   or a.key = (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name)))) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at > now() - interval '3 minutes'
    ), '[]'::jsonb),
    'offline_agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', 'offline', 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail, 'context_pct', r.context_pct, 'mod_loaded', r.mod_loaded,
        'kind', r.kind, 'receivable', r.receivable, 'model', r.model, 'hidden', r.hidden, 'elevated', r.elevated,
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'online', false,
        'last_active_at', (select p.last_active_at from relay.partners p where p.node = n.id and p.current_name = r.name),
        'avatar_updated_at', (select case when p.avatar is null then null else p.avatar_updated_at end from relay.partners p where p.node = n.id and p.current_name = r.name),
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
  from relay.nodes n where n.status = 'active' and n.tenant_id is not distinct from p_tenant
    and (coalesce(p_include_web, false) or coalesce(n.kind, '') <> 'web');
$function$;

commit;
