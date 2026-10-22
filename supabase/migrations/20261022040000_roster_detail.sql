-- 視窗名單多一個選填的 detail（Claude Code 外掛狀態的補充說明：背景工作 2 件／等你回答…，最多 80 字）。
-- 相容：新欄位可空；舊機器橋不送 detail＝null，舊用戶端讀名單時多一個 detail 鍵會直接略過。
--  1. relay.roster 加 detail。
--  2. irori_relay_roster：照舊驗證與寫入，多存 detail（只收字串，超過 80 字截斷，不因此拒絕整份名單）。
--  3. irori_relay_list：agents 每列多帶 detail，其餘（含 asn）與上一版完全相同。
-- 先不套用：部署由負責的 session 處理。
begin;

alter table relay.roster add column if not exists detail text;

CREATE OR REPLACE FUNCTION public.irori_relay_roster(p_node text, p_agents jsonb)
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
  -- same name twice in one report: the last one wins；engine 格式不對就當沒帶；detail 不是字串就當沒帶、過長截斷
  insert into relay.roster (node, name, status, cwd_label, engine, detail)
    select distinct on (a.v->>'name') p_node, a.v->>'name', nullif(a.v->>'status', ''), nullif(a.v->>'cwd_label', ''),
           case when a.v->>'engine' ~ '^[a-z][a-z0-9_-]{0,19}$' then a.v->>'engine' end,
           case when jsonb_typeof(a.v->'detail') = 'string' then nullif(left(btrim(a.v->>'detail'), 80), '') end
    from jsonb_array_elements(p_agents) with ordinality as a(v, ord)
    order by a.v->>'name', a.ord desc;
  get diagnostics v_n = row_count;
  return jsonb_build_object('count', v_n);
end;
$function$;

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
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', r.status, 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at > now() - interval '3 minutes'
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
