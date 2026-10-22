-- 手機版「幫電腦開新夥伴」（#158）：遠端開視窗（launch／launchers）原本只准 role='owner' 的節點下令。
-- 手機與用登入建立的電腦節點是 role='member'，所以多認一條：呼叫端帶了本人簽章（Edge Function 驗過登入憑證，把使用者 id 傳進來），
-- 而且「這個節點與它的租戶都是這個人的」（asn_user_owns_node，與以人寄出、群組發言同一個核對函式）就視同擁有者。
-- 沒帶簽章＝與以前完全相同（只有 role='owner' 的節點准），舊的 Edge Function 呼叫舊簽章的版本也不會壞（新參數有預設值）。
-- 不改任何資料表。先不套用：需要小良哥同意後再套（見 CLAUDE.md）。部署順序：先套 migration，再部署 relay 函式，再發新版 ASN。
begin;

-- 換簽章要先拿掉舊的版本（與 20261021060000_owner_signed.sql 同樣做法）
drop function if exists public.irori_relay_launch(text, text, text, text, text, text);
drop function if exists public.irori_relay_launchers(text, uuid[]);

create or replace function public.irori_relay_launch(p_actor text, p_node text, p_profile text, p_name text, p_cwd text, p_first text, p_signed_user uuid default null::uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_l jsonb;
  v_topic text;
  v_max int;
  v_id uuid;
  v_t uuid;
begin
  select tenant_id into v_t from relay.nodes
    where id = p_actor and status = 'active'
      and (role = 'owner' or public.asn_user_owns_node(p_signed_user, p_actor));
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select launcher, bell_topic into v_l, v_topic from relay.nodes
    where id = p_node and status = 'active' and tenant_id is not distinct from v_t;
  if v_topic is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_l is null then
    return jsonb_build_object('error', 'no_launcher');
  end if;
  if not public.irori_relay_launch_name_ok(p_name) then
    return jsonb_build_object('error', 'bad_name');
  end if;
  if p_profile is null or not exists (select 1 from jsonb_array_elements(v_l->'profiles') p where p->>'id' = p_profile) then
    return jsonb_build_object('error', 'bad_profile');
  end if;
  if p_cwd is null or not exists (select 1 from jsonb_array_elements_text(v_l->'cwd_allow') c where c = p_cwd) then
    return jsonb_build_object('error', 'bad_cwd');
  end if;
  if p_first is not null and char_length(p_first) > 4000 then
    return jsonb_build_object('error', 'bad_first_message');
  end if;
  if exists (select 1 from relay.roster where node = p_node and lower(name) = lower(p_name) and seen_at > now() - interval '3 minutes')
     or exists (select 1 from relay.launches where node = p_node and lower(name) = lower(p_name)
                and (status in ('pending', 'taken') and created_at > now() - interval '10 minutes'
                     or status in ('ok', 'unconfirmed') and done_at > now() - interval '3 minutes')) then
    return jsonb_build_object('error', 'name_taken');
  end if;
  v_max := coalesce((v_l->>'max_per_hour')::int, 6);
  if (select count(*) from relay.launches where node = p_node and created_at > now() - interval '1 hour') >= v_max then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.launches (requested_by, node, profile, name, cwd, first_message, tenant_id)
    values (p_actor, p_node, p_profile, p_name, p_cwd, nullif(p_first, ''), v_t)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

create or replace function public.irori_relay_launchers(p_actor text, p_ids uuid[], p_signed_user uuid default null::uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_mach jsonb; v_recent jsonb; v_t uuid;
begin
  select tenant_id into v_t from relay.nodes
    where id = p_actor and status = 'active'
      and (role = 'owner' or public.asn_user_owns_node(p_signed_user, p_actor));
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'node', n.id, 'name', n.name, 'machine', n.machine, 'launcher', n.launcher, 'launcher_at', n.launcher_at,
      'online', coalesce(n.last_seen_at > now() - interval '3 minutes', false)) order by n.id), '[]'::jsonb)
    into v_mach from relay.nodes n
    where n.status = 'active' and n.launcher is not null and n.tenant_id is not distinct from v_t;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'node', l.node, 'profile', l.profile, 'name', l.name, 'cwd', l.cwd,
      'status', case when l.status = 'pending' and l.created_at <= now() - interval '2 minutes' then 'failed' else l.status end,
      'detail', case when l.status = 'pending' and l.created_at <= now() - interval '2 minutes'
                     then '機器橋 2 分鐘內沒有取走（電腦可能沒開或橋沒在跑）' else l.detail end,
      'created_at', l.created_at, 'done_at', l.done_at) order by l.created_at desc), '[]'::jsonb)
    into v_recent from (
      select * from relay.launches
      where tenant_id is not distinct from v_t
        and ((p_ids is null and created_at > now() - interval '7 days') or id = any(p_ids))
      order by created_at desc limit 30
    ) l;
  return jsonb_build_object('machines', v_mach, 'launches', v_recent);
end;
$function$;

revoke all on function public.irori_relay_launch(text, text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.irori_relay_launch(text, text, text, text, text, text, uuid) to service_role;
revoke all on function public.irori_relay_launchers(text, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.irori_relay_launchers(text, uuid[], uuid) to service_role;

commit;
