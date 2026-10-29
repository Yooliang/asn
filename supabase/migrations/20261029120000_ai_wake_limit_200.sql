-- 群組 AI 之間互相叫醒的輪數上限：範圍由 0～20 放寬到 0～200，沒設定過的帳號預設由 5 改 20（小良哥 2026-10-29 #1415／#1416）。
-- 已經設過值的帳號不動（features.ai_wake_limit 原樣保留）；只動兩個函式的範圍與預設：
--  1. relay.room_ai_wake_limit：讀值上限 200、沒設定＝20
--  2. public.asn_account_settings：寫入範圍 0～200（其他 bad_request）；讀不到設定回 20
-- 回復：把 20261023190000_group_ai_wake_limit.sql 裡這兩個函式的定義再套一次。
begin;

create or replace function relay.room_ai_wake_limit(p_room text)
 returns integer language sql stable security definer set search_path to ''
as $function$
  select coalesce(
    (select case when (t.features->>'ai_wake_limit') ~ '^[0-9]{1,3}$' then least((t.features->>'ai_wake_limit')::int, 200) end
     from relay.tenants t where t.owner_user = relay.room_host(p_room)),
    20);
$function$;

create or replace function public.asn_account_settings(p_user uuid, p_ai_wake_limit integer default null)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_t relay.tenants%rowtype;
begin
  if p_user is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select * into v_t from relay.tenants where owner_user = p_user;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_ai_wake_limit is not null then
    if p_ai_wake_limit not between 0 and 200 then
      return jsonb_build_object('error', 'bad_request');
    end if;
    update relay.tenants set features = coalesce(features, '{}'::jsonb) || jsonb_build_object('ai_wake_limit', p_ai_wake_limit) where id = v_t.id;
    return jsonb_build_object('ai_wake_limit', p_ai_wake_limit);
  end if;
  return jsonb_build_object('ai_wake_limit',
    case when (v_t.features->>'ai_wake_limit') ~ '^[0-9]{1,3}$' then least((v_t.features->>'ai_wake_limit')::int, 200) else 20 end);
end;
$function$;

revoke all on function public.asn_account_settings(uuid, integer) from public, anon, authenticated;
grant execute on function public.asn_account_settings(uuid, integer) to service_role;

commit;
