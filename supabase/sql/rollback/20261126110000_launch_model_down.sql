-- 退回 20261126110000_launch_model.sql。順序：還原約束 → 還原函式 → 移除欄位。
-- 約束：model、model_used、並存的三條先拿掉，才能移除欄位。
-- launches_pi_model_check 保留統一規則的版本：表上已有（或退回期間仍在途）的 pi 值可能含窄規則不收的字元，
-- 換回窄規則會讓這些列在之後的狀態更新（取件、逾時、回報結果）全部被約束擋下。窄規則是統一規則的子集，
-- 保留較寬的約束不影響舊函式（9 參數版的窄規則仍在函式本體裡擋）。
-- 退回後：10 參數版與 5 參數版的 launch_result 消失；已存的 model、model_used 隨欄位移除。
begin;

alter table relay.launches drop constraint if exists launches_model_used_check;
alter table relay.launches drop constraint if exists launches_model_pi_excl_check;
alter table relay.launches drop constraint if exists launches_model_check;

-- 9 參數版換回上一版（本體逐字取自 20261123120000_online_window.sql）
create or replace function public.asn_relay_launch(p_actor text, p_node text, p_profile text, p_name text, p_cwd text, p_first text, p_signed_user uuid, p_pi_provider text, p_pi_model text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if not public.asn_relay_launch_name_ok(p_name) then
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
  -- 經 pi 的提供者與模型（D2）：兩個都給或都不給；格式照 piModelWire（英數開頭，之後英數與 . _ -，最多 50 字）
  if (p_pi_provider is null) <> (p_pi_model is null)
     or (p_pi_provider is not null and (p_pi_provider !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$' or p_pi_model !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$')) then
    return jsonb_build_object('error', 'bad_pi_model');
  end if;
  if exists (select 1 from relay.roster where node = p_node and lower(name) = lower(p_name) and seen_at > now() - relay.online_window())
     or exists (select 1 from relay.launches where node = p_node and lower(name) = lower(p_name)
                and (status in ('pending', 'taken') and created_at > now() - interval '10 minutes'
                     or status in ('ok', 'unconfirmed') and done_at > now() - interval '3 minutes')) then
    return jsonb_build_object('error', 'name_taken');
  end if;
  v_max := coalesce((v_l->>'max_per_hour')::int, 6);
  if (select count(*) from relay.launches where node = p_node and created_at > now() - interval '1 hour') >= v_max then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.launches (requested_by, node, profile, name, cwd, first_message, tenant_id, pi_provider, pi_model)
    values (p_actor, p_node, p_profile, p_name, p_cwd, nullif(p_first, ''), v_t, p_pi_provider, p_pi_model)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

drop function if exists public.asn_relay_launch(text, text, text, text, text, text, uuid, text, text, text);
drop function if exists public.asn_relay_launch_result(text, uuid, text, text, text);

-- 取件換回上一版（本體逐字取自 20261028160000_launch_pi_model.sql）
create or replace function public.asn_relay_launch_pending(p_node text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_out jsonb;
begin
  update relay.launches set status = 'failed', detail = '機器橋 2 分鐘內沒有取走（電腦可能沒開或橋沒在跑）', done_at = now()
    where node = p_node and status = 'pending' and created_at <= now() - interval '2 minutes';
  with t as (
    update relay.launches set status = 'taken', taken_at = now()
      where node = p_node and status = 'pending'
      returning id, requested_by, profile, name, cwd, first_message, created_at, pi_provider, pi_model
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'requested_by', t.requested_by, 'profile', t.profile, 'name', t.name, 'cwd', t.cwd,
      'first_message', t.first_message, 'created_at', t.created_at, 'pi_provider', t.pi_provider, 'pi_model', t.pi_model) order by t.created_at), '[]'::jsonb)
    into v_out from t;
  return v_out;
end;
$function$;

-- 最近紀錄換回上一版（本體逐字取自 20261123120000_online_window.sql）
create or replace function public.asn_relay_launchers(p_actor text, p_ids uuid[], p_signed_user uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      'platform', n.platform, 'launch_closed_reason', n.launch_closed_reason,
      'online', coalesce(n.last_seen_at > now() - relay.online_window(), false)) order by n.id), '[]'::jsonb)
    into v_mach from relay.nodes n
    where n.status = 'active' and (n.launcher is not null or n.platform is not null or n.launch_closed_reason is not null)
      and n.tenant_id is not distinct from v_t;
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

alter table relay.launches drop column if exists model_used;
alter table relay.launches drop column if exists model;

commit;
