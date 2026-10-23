-- 名單條目多三個欄位（給 Linux 無頭主機的常駐服務類條目用）：
--   kind       這個條目是什麼：window（有畫面的 AI 視窗，預設）／其他小寫英數字串（例如 service）；格式不對當 window
--   receivable 能不能收信：預設 true；false＝只報告狀態，不收信（投遞到它會被拒收，回 not_receivable）
--   model      背後用的模型名（選填，最多 60 字）
-- 相容：三欄都有預設值；舊機器橋／舊 ASN 回報名單不帶這三欄＝window／true／空，行為與以前完全一樣。
-- 動到的函式：
--  1. asn_relay_roster：以 20261023120000 的定義為基礎，多存三欄（壞值當預設，不拒絕整份名單）。
--  2. asn_relay_list：以 20261023130000 的定義為基礎，agents 與 offline_agents 都多帶三個鍵（舊用戶端略過多出的鍵）。
--  3. asn_relay_send：原函式改名 asn_relay_send_core，同簽章的薄包裝擋掉「收件條目 receivable=false」，其餘原樣轉給 core
--     （voice 版與舊名 irori_ 包裝都是呼叫 asn_relay_send，自動套用）。只比對 to_node＋to_agent 與名單條目同名（不分大小寫）；
--     沒指定視窗、指定的名字沒登記（例如人代號）、視窗類條目都照舊。
-- 先不套用：部署由負責的 session 處理（順序：本 migration → relay Edge Function → 用戶端）。
-- 回復：drop function public.asn_relay_send(...); alter function public.asn_relay_send_core(...) rename to asn_relay_send；
--   asn_relay_roster／asn_relay_list 換回 20261023120000／20261023130000 的定義；欄位留著無害。
begin;

alter table relay.roster add column if not exists kind text not null default 'window';
alter table relay.roster add column if not exists receivable boolean not null default true;
alter table relay.roster add column if not exists model text;

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
  insert into relay.roster (node, name, status, cwd_label, engine, detail, context_pct, mod_loaded, kind, receivable, model)
    select distinct on (a.v->>'name') p_node, a.v->>'name', nullif(a.v->>'status', ''), nullif(a.v->>'cwd_label', ''),
           case when a.v->>'engine' ~ '^[a-z][a-z0-9_-]{0,19}$' then a.v->>'engine' end,
           case when jsonb_typeof(a.v->'detail') = 'string' then nullif(left(btrim(a.v->>'detail'), 80), '') end,
           case when jsonb_typeof(a.v->'context_pct') = 'number' and (a.v->>'context_pct')::numeric between 0 and 100 then round((a.v->>'context_pct')::numeric)::smallint end,
           case when jsonb_typeof(a.v->'mod_loaded') = 'boolean' then (a.v->>'mod_loaded')::boolean end,
           case when jsonb_typeof(a.v->'kind') = 'string' and a.v->>'kind' ~ '^[a-z][a-z0-9_-]{0,19}$' then a.v->>'kind' else 'window' end,
           case when jsonb_typeof(a.v->'receivable') = 'boolean' then (a.v->>'receivable')::boolean else true end,
           case when jsonb_typeof(a.v->'model') = 'string' then nullif(left(btrim(a.v->>'model'), 60), '') end
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
revoke all on function public.asn_relay_roster(text, jsonb) from public, anon, authenticated;
grant execute on function public.asn_relay_roster(text, jsonb) to service_role;

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
        'kind', r.kind, 'receivable', r.receivable, 'model', r.model,
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'online', true,
        'archived', exists (select 1 from relay.partner_archives a where a.tenant_id is not distinct from p_tenant
                              and (a.key = 'n:' || n.id || '/' || r.name
                                   or a.key = (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name)))) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at > now() - interval '3 minutes'
    ), '[]'::jsonb),
    'offline_agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', 'offline', 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail, 'context_pct', r.context_pct, 'mod_loaded', r.mod_loaded,
        'kind', r.kind, 'receivable', r.receivable, 'model', r.model,
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

-- 寄信：原函式改名為 core（內容不動、授權沿用），同簽章薄包裝負責拒收
alter function public.asn_relay_send(text, text, text, text, text, uuid, boolean, uuid, boolean) rename to asn_relay_send_core;
revoke all on function public.asn_relay_send_core(text, text, text, text, text, uuid, boolean, uuid, boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_send_core(text, text, text, text, text, uuid, boolean, uuid, boolean) to service_role;

create or replace function public.asn_relay_send(
  p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid,
  p_expects_reply boolean default null::boolean, p_signed_user uuid default null::uuid,
  p_as_person boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if p_to_node is not null and p_to_agent is not null and exists (
    select 1 from relay.roster r
    where r.node = p_to_node and lower(r.name) = lower(p_to_agent) and r.receivable = false
  ) then
    return jsonb_build_object('error', 'not_receivable');
  end if;
  return public.asn_relay_send_core(p_from_node, p_from_agent, p_to_node, p_to_agent, p_body, p_reply_to,
                                    p_expects_reply, p_signed_user, p_as_person);
end;
$function$;
revoke all on function public.asn_relay_send(text, text, text, text, text, uuid, boolean, uuid, boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_send(text, text, text, text, text, uuid, boolean, uuid, boolean) to service_role;

commit;
