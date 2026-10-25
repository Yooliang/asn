-- 名單多一個選填欄位 hidden（布林）：這個視窗目前是不是隱藏的（Windows 主控台視窗的 IsWindowVisible 取反）。
-- 前景／背景只代表「視窗隱藏或不隱藏」（小良哥 2026-10-26 #205／#207），與 ACP 通道無關；沒有視窗（ACP 工作者、雲端、非 Windows）一律不帶＝null。
-- 只動兩個函式：asn_relay_roster（寫入，多收 hidden，型別不對當 null）與 asn_relay_list（讀出，多回 hidden）；其餘與現行定義完全相同。
-- 舊版橋沒帶＝null，舊用戶端看不到這個欄位也不壞（可選欄位）。
-- 回復：把 20261024110000_roster_kind.sql 的 asn_relay_roster／asn_relay_list 定義再套一次；欄位可留著（新增欄位不影響舊函式）。
begin;

alter table relay.roster add column if not exists hidden boolean;

CREATE OR REPLACE FUNCTION public.asn_relay_roster(p_node text, p_agents jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_n int;
  v_old jsonb;
  v_new jsonb;
  v_changed boolean;
  v_tenant uuid;
  v_topics jsonb := '[]'::jsonb;
begin
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active' and (can_invite or can_roster)) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_agents is null or jsonb_typeof(p_agents) <> 'array' or jsonb_array_length(p_agents) > 100 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_agents) a
    where jsonb_typeof(a) <> 'object' or jsonb_typeof(a->'name') is distinct from 'string'
       or char_length(a->>'name') not between 1 and 60
       or char_length(coalesce(a->>'status', '')) > 20 or char_length(coalesce(a->>'cwd_label', '')) > 80
  ) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select coalesce(jsonb_agg(jsonb_build_array(r.name, coalesce(r.status, ''), coalesce(r.detail, '')) order by r.name), '[]'::jsonb)
    into v_old from relay.roster r where r.node = p_node;
  delete from relay.roster where node = p_node;
  insert into relay.roster (node, name, status, cwd_label, engine, detail, context_pct, mod_loaded, kind, receivable, model, hidden)
    select distinct on (a.v->>'name') p_node, a.v->>'name', nullif(a.v->>'status', ''), nullif(a.v->>'cwd_label', ''),
           case when a.v->>'engine' ~ '^[a-z][a-z0-9_-]{0,19}$' then a.v->>'engine' end,
           case when jsonb_typeof(a.v->'detail') = 'string' then nullif(left(btrim(a.v->>'detail'), 80), '') end,
           case when jsonb_typeof(a.v->'context_pct') = 'number' and (a.v->>'context_pct')::numeric between 0 and 100 then round((a.v->>'context_pct')::numeric)::smallint end,
           case when jsonb_typeof(a.v->'mod_loaded') = 'boolean' then (a.v->>'mod_loaded')::boolean end,
           case when jsonb_typeof(a.v->'kind') = 'string' and a.v->>'kind' ~ '^[a-z][a-z0-9_-]{0,19}$' then a.v->>'kind' else 'window' end,
           case when jsonb_typeof(a.v->'receivable') = 'boolean' then (a.v->>'receivable')::boolean else true end,
           case when jsonb_typeof(a.v->'model') = 'string' then nullif(left(btrim(a.v->>'model'), 60), '') end,
           case when jsonb_typeof(a.v->'hidden') = 'boolean' then (a.v->>'hidden')::boolean end
    from jsonb_array_elements(p_agents) with ordinality as a(v, ord)
    order by a.v->>'name', a.ord desc;
  get diagnostics v_n = row_count;
  select coalesce(jsonb_agg(jsonb_build_array(r.name, coalesce(r.status, ''), coalesce(r.detail, '')) order by r.name), '[]'::jsonb)
    into v_new from relay.roster r where r.node = p_node;
  v_changed := v_old is distinct from v_new;
  if v_changed then
    update relay.nodes set roster_bell_at = now()
      where id = p_node and (roster_bell_at is null or roster_bell_at < now() - interval '2 seconds')
      returning tenant_id into v_tenant;
    if found then
      select coalesce(jsonb_agg(distinct o.bell_topic), '[]'::jsonb) into v_topics
        from relay.nodes o
        where o.id <> p_node and o.status = 'active' and o.bell_topic is not null
          and o.tenant_id is not distinct from v_tenant
          and o.last_seen_at > now() - interval '10 minutes';
    end if;
  end if;
  return jsonb_build_object('count', v_n, 'changed', v_changed, 'bell_topics', v_topics);
end;
$function$;

CREATE OR REPLACE FUNCTION public.asn_relay_list(p_tenant uuid)
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
    'claude_mod', case when n.claude_mod is null then null else n.claude_mod || jsonb_build_object('updated_at', n.claude_mod_at) end,
    'avatar_updated_at', case when n.avatar is null then null else n.avatar_updated_at end,
    'archived_keys', coalesce((select jsonb_agg(a.key order by a.key) from relay.partner_archives a
                                where a.tenant_id is not distinct from p_tenant and a.node = n.id), '[]'::jsonb),
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', r.status, 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail, 'context_pct', r.context_pct, 'mod_loaded', r.mod_loaded,
        'kind', r.kind, 'receivable', r.receivable, 'model', r.model, 'hidden', r.hidden,
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'online', true,
        'archived', exists (select 1 from relay.partner_archives a where a.tenant_id is not distinct from p_tenant
                              and (a.key = 'n:' || n.id || '/' || r.name
                                   or a.key = (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name)))) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at > now() - interval '3 minutes'
    ), '[]'::jsonb),
    'offline_agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', 'offline', 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail, 'context_pct', r.context_pct, 'mod_loaded', r.mod_loaded,
        'kind', r.kind, 'receivable', r.receivable, 'model', r.model, 'hidden', r.hidden,
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

commit;
