-- 0.2 D2（#422）：遠端開 pi 時帶提供者和模型。手機「經 pi」選的提供者／模型存進開窗表，機器橋取走時一起拿到。
-- 1. relay.launches 加 pi_provider、pi_model 兩個可為 null 的欄位：兩個都有或都沒有；格式照 piModelWire（英數開頭，之後英數與 . _ -，最多 50 字）。
-- 2. 新的 asn_relay_launch（多 p_pi_provider、p_pi_model，9 個參數、沒有預設值）：本體照正式庫現行的 7 參數版本，只多驗這兩個並存進表。
--    原本的 7 參數版本不動：舊版 relay 照舊呼叫它，存進去的兩欄是 null。新版 relay 只有帶了 pi 的提供者與模型才呼叫 9 參數版本。
-- 3. asn_relay_launch_pending 多回這兩欄（舊版電腦端不認得就略過）。本體照正式庫現行定義，只多兩欄。
-- 只加欄位與函式，不改舊值。部署順序：migration → relay 函式 → 用戶端。
begin;

alter table relay.launches add column if not exists pi_provider text;
alter table relay.launches add column if not exists pi_model text;
alter table relay.launches drop constraint if exists launches_pi_model_check;
alter table relay.launches add constraint launches_pi_model_check check (
  (pi_provider is null) = (pi_model is null)
  and (pi_provider is null or (pi_provider ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$' and pi_model ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$')));

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
  insert into relay.launches (requested_by, node, profile, name, cwd, first_message, tenant_id, pi_provider, pi_model)
    values (p_actor, p_node, p_profile, p_name, p_cwd, nullif(p_first, ''), v_t, p_pi_provider, p_pi_model)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

revoke all on function public.asn_relay_launch(text, text, text, text, text, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_launch(text, text, text, text, text, text, uuid, text, text) to service_role;

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

commit;
