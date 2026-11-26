-- 退回 20261126110000_launch_model.sql。順序：先退 Edge，再退 SQL（本檔）；兩階段都退時，本檔先跑，再跑 20261126100000 的回退。
-- 本檔內順序：還原約束 → 還原函式 → 移除欄位。
-- 約束：model、model_used、並存的三條先拿掉，才能移除欄位。
-- launches_pi_model_check 保留統一規則（寬規則），但改成內嵌的等價正規式，不依賴 relay.valid_model_id：
-- 20261126100000 的回退會 drop 那支函式，約束若還引用它，兩階段都退時會中止。
-- 保留寬規則的原因：表上已有（或退回期間仍在途）的 pi 值可能含窄規則不收的字元，
-- 換回窄規則會讓這些列在之後的狀態更新（取件、逾時、回報結果）全部被約束擋下。窄規則是統一規則的子集，
-- 保留較寬的約束不影響舊函式（9 參數版的窄規則仍在函式本體裡擋）。
-- 內嵌的兩條正規式與 relay.valid_model_id 逐字相同（tests/launch_model_sql.test.mjs 用共用向量逐筆比對兩者）。
-- 約束是完整驗證（沒有 NOT VALID）：重建約束時會鎖住整張 relay.launches 做驗證；表小，風險低。
-- 退回後：10 參數版與 5 參數版的 launch_result 消失；asn_relay_set_launcher 回到 20261126100000 的版本（不再收 launch_model，
-- 已存在 launcher 裡的旗標不動，下一次回報時被覆蓋）；已存的 model、model_used 隨欄位移除。
begin;

alter table relay.launches drop constraint if exists launches_model_used_check;
alter table relay.launches drop constraint if exists launches_model_pi_excl_check;
alter table relay.launches drop constraint if exists launches_model_check;
alter table relay.launches drop constraint if exists launches_pi_model_check;
alter table relay.launches add constraint launches_pi_model_check check (
  (pi_provider is null) = (pi_model is null)
  and (pi_provider is null or (
    pi_provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,99}$' and pi_provider !~ '(^|/)\.{0,2}(/|$)'
    and pi_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,99}$' and pi_model !~ '(^|/)\.{0,2}(/|$)')));

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

-- 啟動設定摘要換回上一版（本體逐字取自 20261126100000_launcher_models.sql）
create or replace function public.asn_relay_set_launcher(p_node text, p_launcher jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_pi jsonb; v_models jsonb;
begin
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active' and (can_invite or can_roster)) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_launcher is not null and (
       jsonb_typeof(p_launcher) <> 'object'
    or jsonb_typeof(p_launcher->'profiles') is distinct from 'array'
    or jsonb_typeof(p_launcher->'cwd_allow') is distinct from 'array'
    or jsonb_array_length(p_launcher->'profiles') > 20
    or jsonb_array_length(p_launcher->'cwd_allow') > 50
    or octet_length((p_launcher - 'pi_models' - 'models')::text) > 16000
    or exists (select 1 from jsonb_array_elements(p_launcher->'profiles') p
               where jsonb_typeof(p->'id') is distinct from 'string' or char_length(p->>'id') not between 1 and 40
                  or char_length(coalesce(p->>'label', '')) > 60)
    or exists (select 1 from jsonb_array_elements(p_launcher->'cwd_allow') c
               where jsonb_typeof(c) <> 'string' or char_length(c #>> '{}') not between 1 and 260)
  ) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- pi_models：只留格式合格的 { provider, model }，最多 200 筆；沒有或不是陣列就不存
  if p_launcher is not null and jsonb_typeof(p_launcher->'pi_models') = 'array' then
    select jsonb_agg(jsonb_build_object('provider', e->>'provider', 'model', e->>'model') order by o) into v_pi
      from (
        select e, o from jsonb_array_elements(p_launcher->'pi_models') with ordinality as t(e, o)
        where jsonb_typeof(e) = 'object'
          and jsonb_typeof(e->'provider') = 'string' and jsonb_typeof(e->'model') = 'string'
          and relay.valid_model_id(e->>'provider')
          and relay.valid_model_id(e->>'model')
        order by o limit 200
      ) s;
    if v_pi is not null and octet_length(v_pi::text) > 24000 then
      v_pi := null;
    end if;
  end if;
  -- models：本身另限 32000 bytes（jsonb::text），超過只丟 models；不是陣列就不存
  if p_launcher is not null and jsonb_typeof(p_launcher->'models') = 'array'
     and octet_length((p_launcher->'models')::text) <= 32000 then
    v_models := relay.sanitize_launcher_models(p_launcher->'models');
  end if;
  update relay.nodes set launcher = case when p_launcher is null then null else jsonb_build_object(
      'profiles', p_launcher->'profiles', 'cwd_allow', p_launcher->'cwd_allow',
      'max_per_hour', least(greatest(coalesce((p_launcher->>'max_per_hour')::int, 6), 1), 20))
      || case when v_pi is null then '{}'::jsonb else jsonb_build_object('pi_models', v_pi) end
      || case when v_models is null then '{}'::jsonb else jsonb_build_object('models', v_models) end end,
    launcher_at = now()
  where id = p_node;
  return jsonb_build_object('ok', true);
end;
$function$;

alter table relay.launches drop column if exists model_used;
alter table relay.launches drop column if exists model;

commit;
