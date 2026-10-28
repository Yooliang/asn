-- 0.2 E1（#397）：後台記錄「最後活動時間」（寄信與群組發言時寫入），名單一起回，活躍度燈號才看得到別台設備、終端裡的夥伴。
-- 1. relay.nodes、relay.partners 各加一個可為 null 的 last_active_at（null＝從沒活動）；不改舊值。
-- 2. asn_relay_touch_active(p_node, p_agent)：只給 service_role（relay 函式在寄信、群組發言成功之後呼叫，p_node 是 relay 已驗證的節點，不從請求內容取）。
--    節點與夥伴各自節流：同一個節點／同一位夥伴 10 秒內只寫第一次（單一 UPDATE 的條件，原子的，並發也不會重複寫）。
--    夥伴用 current_name 精確比對（不看舊名字，避免寫到別人）；解不到夥伴只寫節點。
-- 3. asn_relay_list（irori_relay_list 呼叫它）多回三處 last_active_at：節點、在線夥伴、離線夥伴；其餘照正式庫現行定義一個字不動
--    （2026-10-28 唯讀取自正式庫，基準檔 tests/fixtures/asn_relay_list.prod-20261028.sql，測試比對「只多這三行」）。
-- 只加欄位與函式；舊版用戶端不認得新欄位就略過。部署順序：migration → relay 函式 → 用戶端。
begin;

alter table relay.nodes add column if not exists last_active_at timestamptz;
alter table relay.partners add column if not exists last_active_at timestamptz;

create or replace function public.asn_relay_touch_active(p_node text, p_agent text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_node int := 0;
  v_partner int := 0;
begin
  if p_node is null or p_node = '' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.nodes n set last_active_at = now()
    where n.id = p_node and n.status = 'active'
      and (n.last_active_at is null or n.last_active_at <= now() - interval '10 seconds');
  get diagnostics v_node = row_count;
  if p_agent is not null and p_agent <> '' and char_length(p_agent) <= 100 then
    update relay.partners p set last_active_at = now()
      where p.node = p_node and p.current_name = p_agent
        and (p.last_active_at is null or p.last_active_at <= now() - interval '10 seconds');
    get diagnostics v_partner = row_count;
  end if;
  return jsonb_build_object('node', v_node, 'partner', v_partner);
end;
$function$;
revoke all on function public.asn_relay_touch_active(text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_touch_active(text, text) to service_role;

create or replace function public.asn_relay_list(p_tenant uuid)
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
    'last_active_at', n.last_active_at,
    'claude_mod', case when n.claude_mod is null then null else n.claude_mod || jsonb_build_object('updated_at', n.claude_mod_at) end,
    'avatar_updated_at', case when n.avatar is null then null else n.avatar_updated_at end,
    'archived_keys', coalesce((select jsonb_agg(a.key order by a.key) from relay.partner_archives a
                                where a.tenant_id is not distinct from p_tenant and a.node = n.id), '[]'::jsonb),
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', r.status, 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail, 'context_pct', r.context_pct, 'mod_loaded', r.mod_loaded,
        'kind', r.kind, 'receivable', r.receivable, 'model', r.model, 'hidden', r.hidden,
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'online', true,
        'last_active_at', (select p.last_active_at from relay.partners p where p.node = n.id and p.current_name = r.name),
        'archived', exists (select 1 from relay.partner_archives a where a.tenant_id is not distinct from p_tenant
                              and (a.key = 'n:' || n.id || '/' || r.name
                                   or a.key = (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name)))) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at > now() - interval '3 minutes'
    ), '[]'::jsonb),
    'offline_agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', 'offline', 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail, 'context_pct', r.context_pct, 'mod_loaded', r.mod_loaded,
        'kind', r.kind, 'receivable', r.receivable, 'model', r.model, 'hidden', r.hidden,
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'online', false,
        'last_active_at', (select p.last_active_at from relay.partners p where p.node = n.id and p.current_name = r.name),
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

commit;
