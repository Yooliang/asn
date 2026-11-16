-- #1634：視窗是不是「用系統管理員身分開的」（電腦端 #1630／#1633 會在名單條目送 elevated），後台要存下來、名單讀出時帶回，手機才看得到標記。
-- 重要：elevated 只是「顯示用的資訊」，不能拿來當任何權限判斷、放行或擋下的依據（它是電腦自己回報的，只用來在畫面上提醒本人「這個視窗收發室轉不進去」）。
-- 做了三件事，其餘照現行定義一個字不動（asn_relay_roster 取自 20261028200000_roster_active_at.sql，asn_relay_list 取自 20261028220000_partner_avatar.sql；
-- 之後沒有別的 migration 再改過這兩支；測試比對「只多這幾行」）：
--   1. relay.roster 加 elevated boolean（可空）。
--   2. asn_relay_roster：insert 欄位清單與 select 各多一個 elevated，只收 JSON 布林 true，其他（false、字串、數字、物件、沒帶）一律存 null。
--   3. asn_relay_list：在線夥伴與離線夥伴兩個分支各多一行 'elevated', r.elevated（沒有就是 null）。
-- 舊版電腦不帶這個欄位：存 null、讀出 null，手機前端把 null 當沒有；舊的讀取端多一個鍵會被忽略。
-- 部署順序：migration → Edge（_shared/roster.ts 收下 elevated）→ 新版 ASN。提早上任何一步都不會壞。
-- 授權不動（create or replace 不改既有的 execute 授權）。
-- 回復：supabase/sql/rollback/20261117200000_roster_elevated_down.sql（兩個函式換回上一版原文、drop 欄位）。
begin;

alter table relay.roster add column if not exists elevated boolean;

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
  insert into relay.roster (node, name, status, cwd_label, engine, detail, context_pct, mod_loaded, kind, receivable, model, hidden, elevated)
    select distinct on (a.v->>'name') p_node, a.v->>'name', nullif(a.v->>'status', ''), nullif(a.v->>'cwd_label', ''),
           case when a.v->>'engine' ~ '^[a-z][a-z0-9_-]{0,19}$' then a.v->>'engine' end,
           case when jsonb_typeof(a.v->'detail') = 'string' then nullif(left(btrim(a.v->>'detail'), 80), '') end,
           case when jsonb_typeof(a.v->'context_pct') = 'number' and (a.v->>'context_pct')::numeric between 0 and 100 then round((a.v->>'context_pct')::numeric)::smallint end,
           case when jsonb_typeof(a.v->'mod_loaded') = 'boolean' then (a.v->>'mod_loaded')::boolean end,
           case when jsonb_typeof(a.v->'kind') = 'string' and a.v->>'kind' ~ '^[a-z][a-z0-9_-]{0,19}$' then a.v->>'kind' else 'window' end,
           case when jsonb_typeof(a.v->'receivable') = 'boolean' then (a.v->>'receivable')::boolean else true end,
           case when jsonb_typeof(a.v->'model') = 'string' then nullif(left(btrim(a.v->>'model'), 60), '') end,
           case when jsonb_typeof(a.v->'hidden') = 'boolean' then (a.v->>'hidden')::boolean end,
           case when jsonb_typeof(a.v->'elevated') = 'boolean' and (a.v->>'elevated')::boolean then true end
    from jsonb_array_elements(p_agents) with ordinality as a(v, ord)
    order by a.v->>'name', a.ord desc;
  get diagnostics v_n = row_count;
  -- 0.2 E2／E4（#397）：橋回報的最後收信／忙碌時間（active_at，毫秒）寫進夥伴的最後活動時間
  update relay.partners p set last_active_at = t.at
    from (select a.v->>'name' as name, max(least(to_timestamp((a.v->>'active_at')::numeric::double precision / 1000), now())) as at
            from jsonb_array_elements(p_agents) a(v)
            where jsonb_typeof(a.v->'active_at') = 'number' and (a.v->>'active_at')::numeric between 1 and 9007199254740991
            group by a.v->>'name') t
    where p.node = p_node and p.current_name = t.name and t.at > now() - interval '30 days'
      and (p.last_active_at is null or p.last_active_at <= t.at - interval '10 seconds');
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
  from relay.nodes n where n.status = 'active' and n.tenant_id is not distinct from p_tenant;
$function$;

commit;
