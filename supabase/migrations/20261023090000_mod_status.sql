-- 各台電腦的 Claude 外掛（asn@asn）狀態主動回報，以及每個視窗有沒有載入外掛。
-- 相容：全是新增的可空欄位與新函式；舊機器橋不送＝null，舊用戶端讀名單時多的鍵直接略過。
--  1. relay.nodes 加 claude_mod（jsonb：state／version／reason）與 claude_mod_at；relay.roster 加 mod_loaded。
--  2. asn_relay_set_claude_mod：節點用自己的金鑰回報外掛狀態（只動得到自己這一列；格式不對整筆不收，不影響名單）。
--  3. asn_relay_roster：照舊驗證與寫入，多存 mod_loaded（只收布林，其餘當沒帶）。
--  4. asn_relay_list：每台電腦多帶 claude_mod，agents 與 offline_agents 每列多帶 mod_loaded，其餘與 20261023030000 完全相同。
-- 兩個 irori_relay_ 舊名函式是薄包裝，會自動呼叫新名，不必動。
-- 先不套用：部署由負責的 session 處理。
begin;

alter table relay.nodes add column if not exists claude_mod jsonb;
alter table relay.nodes add column if not exists claude_mod_at timestamptz;
alter table relay.roster add column if not exists mod_loaded boolean;

create or replace function public.asn_relay_set_claude_mod(p_node text, p_mod jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if p_mod is null or jsonb_typeof(p_mod) <> 'object'
     or jsonb_typeof(p_mod->'state') is distinct from 'string'
     or (p_mod->>'state') not in ('installed', 'removed', 'no_claude', 'failed', 'update_failed', 'checking')
     or (p_mod ? 'version' and (jsonb_typeof(p_mod->'version') <> 'string' or p_mod->>'version' !~ '^[0-9A-Za-z.+-]{0,32}$'))
     or (p_mod ? 'reason' and (jsonb_typeof(p_mod->'reason') <> 'string' or char_length(p_mod->>'reason') > 120)) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.nodes set
      claude_mod = jsonb_strip_nulls(jsonb_build_object('state', p_mod->>'state',
        'version', nullif(p_mod->>'version', ''), 'reason', nullif(btrim(p_mod->>'reason'), ''))),
      claude_mod_at = now()
    where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;
revoke all on function public.asn_relay_set_claude_mod(text, jsonb) from public, anon, authenticated;
grant execute on function public.asn_relay_set_claude_mod(text, jsonb) to service_role;

CREATE OR REPLACE FUNCTION public.asn_relay_roster(p_node text, p_agents jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n int;
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
  delete from relay.roster where node = p_node;
  -- same name twice in one report: the last one wins；engine 格式不對就當沒帶；detail 不是字串就當沒帶、過長截斷；context_pct 不是 0～100 的數字就當沒帶
  insert into relay.roster (node, name, status, cwd_label, engine, detail, context_pct, mod_loaded)
    select distinct on (a.v->>'name') p_node, a.v->>'name', nullif(a.v->>'status', ''), nullif(a.v->>'cwd_label', ''),
           case when a.v->>'engine' ~ '^[a-z][a-z0-9_-]{0,19}$' then a.v->>'engine' end,
           case when jsonb_typeof(a.v->'detail') = 'string' then nullif(left(btrim(a.v->>'detail'), 80), '') end,
           case when jsonb_typeof(a.v->'context_pct') = 'number' and (a.v->>'context_pct')::numeric between 0 and 100 then round((a.v->>'context_pct')::numeric)::smallint end,
           case when jsonb_typeof(a.v->'mod_loaded') = 'boolean' then (a.v->>'mod_loaded')::boolean end
    from jsonb_array_elements(p_agents) with ordinality as a(v, ord)
    order by a.v->>'name', a.ord desc;
  get diagnostics v_n = row_count;
  return jsonb_build_object('count', v_n);
end;
$function$;

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
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', r.status, 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail, 'context_pct', r.context_pct, 'mod_loaded', r.mod_loaded,
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'online', true,
        'archived', exists (select 1 from relay.partner_archives a where a.tenant_id is not distinct from p_tenant
                              and a.key = coalesce((select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'n:' || n.id || '/' || r.name))) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at > now() - interval '3 minutes'
    ), '[]'::jsonb),
    'offline_agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', 'offline', 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail, 'context_pct', r.context_pct, 'mod_loaded', r.mod_loaded,
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'online', false,
        'last_seen_at', r.seen_at,
        'archived', exists (select 1 from relay.partner_archives a where a.tenant_id is not distinct from p_tenant
                              and a.key = coalesce((select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'n:' || n.id || '/' || r.name))) order by r.name)
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
