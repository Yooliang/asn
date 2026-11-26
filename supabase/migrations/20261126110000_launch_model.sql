-- #2353 第③階段 PR-1：遠端開窗可以指定型號 model；pi 欄位改用統一型號規則；開窗結果帶回實際採用的型號 model_used。
-- 規則（只寫規則）：
--   * relay.launches 加 model（遠端指定的型號）與 model_used（電腦回報實際採用的型號），兩欄皆可為 null，值走統一規則 relay.valid_model_id。
--   * model 與 pi 欄位（pi_provider、pi_model）不並存。
--   * pi 的提供者與模型：兩欄一起有或一起沒有，各自走統一規則 relay.valid_model_id（取代原本只收英數與 . _ - 的窄規則）。
--   * asn_relay_launch 新增 10 參數版（多 p_model，沒有預設值）。檢查：格式不合或與 pi 欄位並存回 bad_model；
--     目標電腦的 launcher 沒有能力旗標 launch_model: true 回 model_unsupported（不准悄悄改用預設型號）。
--     能力只看旗標，不看 models 陣列（models 可能因超量被丟掉；舊電腦也可能有 models 卻不會讀 model）。
--   * asn_relay_set_launcher 的白名單多收 launch_model：只收布林值 true 或 false，其他型別丟掉；本體照 20261126100000，只多這個鍵。
--     旗標由電腦端（第③階段 PR-2）在摘要送出；還沒送的電腦一律視為不支援。
--   * 9 參數版改成呼叫 10 參數版（p_model 傳 null），兩條路只剩一份規則；7 參數版不動。
--   * asn_relay_launch_pending 多回 model；不帶 model 時為 null，舊用戶端會略過。
--   * asn_relay_launch_result 新增 5 參數版（多 p_model_used，沒有預設值）：值過 relay.valid_model_id 才存，不合格就不存，結果照收；
--     4 參數版不動，舊電腦照舊呼叫它。
--   * asn_relay_launchers 的最近紀錄多回 model、model_used，開窗的人才看得到實際採用的型號。
--   * 遠端指定的型號每一層各自驗證（Edge、SQL、電腦端），不假設上一層驗過。
-- 部署順序：migration → Edge 函式 → 用戶端。新 Edge 配舊 SQL 時，只有帶 model 或 pi 的請求會呼叫不存在的函式。
-- 部署前用 pg_get_functiondef 比對正式庫現行定義：asn_relay_launch（9 參數，依據 20261123120000_online_window.sql）、
--   asn_relay_launch_pending（依據 20261028160000_launch_pi_model.sql）、asn_relay_launchers（依據 20261123120000_online_window.sql）、
--   asn_relay_launch_result（4 參數，依據 20261020000200_relay_functions.sql 的 irori_relay_launch_result 改名而來）。
--   asn_relay_set_launcher（依據 20261126100000_launcher_models.sql）。
-- 部署前再確認三項：
--   1. \dp relay.launches：service_role 沒有直接寫入這張表的權限（寫入只走 SECURITY DEFINER 函式）。
--   2. 正式庫的 relay.launches 上沒有 repo 以外的 trigger 或約束。
--   3. 現有 pi_provider、pi_model 的資料全部符合統一規則（relay.valid_model_id）。
-- 約束是完整驗證（沒有 NOT VALID）：加約束時會鎖住整張 relay.launches 做驗證；表小，風險低。
-- 退回：supabase/sql/rollback/20261126110000_launch_model_down.sql（先退 Edge，再退 SQL；兩階段都退時，先跑本階段的回退，再跑 20261126100000 的回退）
begin;

alter table relay.launches add column if not exists model text;
alter table relay.launches add column if not exists model_used text;

-- pi 兩欄：一起有或一起沒有，各自走統一規則（舊資料都符合舊的窄規則，窄規則是統一規則的子集，不會違反）
alter table relay.launches drop constraint if exists launches_pi_model_check;
alter table relay.launches add constraint launches_pi_model_check check (
  (pi_provider is null) = (pi_model is null)
  and (pi_provider is null or (relay.valid_model_id(pi_provider) and relay.valid_model_id(pi_model))));
alter table relay.launches drop constraint if exists launches_model_check;
alter table relay.launches add constraint launches_model_check check (model is null or relay.valid_model_id(model));
alter table relay.launches drop constraint if exists launches_model_pi_excl_check;
alter table relay.launches add constraint launches_model_pi_excl_check check (model is null or pi_provider is null);
alter table relay.launches drop constraint if exists launches_model_used_check;
alter table relay.launches add constraint launches_model_used_check check (model_used is null or relay.valid_model_id(model_used));

-- 10 參數版：本體照 20261123120000_online_window.sql 的 9 參數版，加 model 的檢查，pi 改用統一規則
create or replace function public.asn_relay_launch(p_actor text, p_node text, p_profile text, p_name text, p_cwd text, p_first text, p_signed_user uuid, p_pi_provider text, p_pi_model text, p_model text)
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
  -- 指定型號：model 與 pi 欄位不並存；格式走統一規則
  if p_model is not null and (p_pi_provider is not null or p_pi_model is not null or not relay.valid_model_id(p_model)) then
    return jsonb_build_object('error', 'bad_model');
  end if;
  -- 經 pi 的提供者與模型：兩個都給或都不給；各自走統一規則
  if (p_pi_provider is null) <> (p_pi_model is null)
     or (p_pi_provider is not null and not (relay.valid_model_id(p_pi_provider) and relay.valid_model_id(p_pi_model))) then
    return jsonb_build_object('error', 'bad_pi_model');
  end if;
  -- 目標電腦沒有能力旗標 launch_model: true：不會用 model，一律明確回錯誤，不准悄悄改用預設型號
  if p_model is not null and (v_l->'launch_model') is distinct from 'true'::jsonb then
    return jsonb_build_object('error', 'model_unsupported');
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
  insert into relay.launches (requested_by, node, profile, name, cwd, first_message, tenant_id, pi_provider, pi_model, model)
    values (p_actor, p_node, p_profile, p_name, p_cwd, nullif(p_first, ''), v_t, p_pi_provider, p_pi_model, p_model)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

revoke all on function public.asn_relay_launch(text, text, text, text, text, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_launch(text, text, text, text, text, text, uuid, text, text, text) to service_role;

-- 9 參數版：薄包裝，呼叫 10 參數版（p_model 傳 null），規則只剩一份。權限沿用原本的（create or replace 不動權限）
create or replace function public.asn_relay_launch(p_actor text, p_node text, p_profile text, p_name text, p_cwd text, p_first text, p_signed_user uuid, p_pi_provider text, p_pi_model text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.asn_relay_launch(p_actor, p_node, p_profile, p_name, p_cwd, p_first, p_signed_user, p_pi_provider, p_pi_model, null::text);
$function$;

-- 取件：多回 model；本體照 20261028160000_launch_pi_model.sql，只多一欄
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
      returning id, requested_by, profile, name, cwd, first_message, created_at, pi_provider, pi_model, model
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'requested_by', t.requested_by, 'profile', t.profile, 'name', t.name, 'cwd', t.cwd,
      'first_message', t.first_message, 'created_at', t.created_at, 'pi_provider', t.pi_provider, 'pi_model', t.pi_model,
      'model', t.model) order by t.created_at), '[]'::jsonb)
    into v_out from t;
  return v_out;
end;
$function$;

-- 回報結果 5 參數版（多 p_model_used）：只能改自己節點、已取走的那筆；型號不合格就不存，結果照收
create or replace function public.asn_relay_launch_result(p_node text, p_id uuid, p_status text, p_detail text, p_model_used text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n int;
begin
  if p_status not in ('ok', 'failed', 'unconfirmed') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.launches
    set status = p_status, detail = left(p_detail, 500), done_at = now(),
        model_used = case when relay.valid_model_id(p_model_used) then p_model_used else model_used end
    where id = p_id and node = p_node and status in ('taken', 'unconfirmed');
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.asn_relay_launch_result(text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_launch_result(text, uuid, text, text, text) to service_role;

-- 最近紀錄多回 model、model_used；本體照 20261123120000_online_window.sql，只多兩欄
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
      'created_at', l.created_at, 'done_at', l.done_at, 'model', l.model, 'model_used', l.model_used) order by l.created_at desc), '[]'::jsonb)
    into v_recent from (
      select * from relay.launches
      where tenant_id is not distinct from v_t
        and ((p_ids is null and created_at > now() - interval '7 days') or id = any(p_ids))
      order by created_at desc limit 30
    ) l;
  return jsonb_build_object('machines', v_mach, 'launches', v_recent);
end;
$function$;

-- 啟動設定摘要：本體照 20261126100000_launcher_models.sql，只多一個能力旗標 launch_model（只收布林值 true／false，其他型別丟掉）
create or replace function public.asn_relay_set_launcher(p_node text, p_launcher jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_pi jsonb; v_models jsonb; v_lm jsonb;
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
  -- launch_model：只收布林值 true 或 false
  if p_launcher is not null and jsonb_typeof(p_launcher->'launch_model') = 'boolean' then
    v_lm := p_launcher->'launch_model';
  end if;
  update relay.nodes set launcher = case when p_launcher is null then null else jsonb_build_object(
      'profiles', p_launcher->'profiles', 'cwd_allow', p_launcher->'cwd_allow',
      'max_per_hour', least(greatest(coalesce((p_launcher->>'max_per_hour')::int, 6), 1), 20))
      || case when v_pi is null then '{}'::jsonb else jsonb_build_object('pi_models', v_pi) end
      || case when v_models is null then '{}'::jsonb else jsonb_build_object('models', v_models) end
      || case when v_lm is null then '{}'::jsonb else jsonb_build_object('launch_model', v_lm) end end,
    launcher_at = now()
  where id = p_node;
  return jsonb_build_object('ok', true);
end;
$function$;

commit;
