-- 群組：AI 之間互相叫醒的輪數上限（帳號等級設定，預設 5，0～20；0＝AI 不能互相叫醒）。
-- 規則：以群組裡「最近一則真人發言」為起點重算；之後每一則「AI 發的、點名了 AI」的訊息算一輪。
-- 已經有 N 輪之後，AI 再點名 AI 就不叫醒（寫進 suppressed，對方讀到 wake_ok=false，只留未讀）；真人再發言就重新起算。
-- 設定值取「群組主持人」帳號的（跨租戶群組也只看主持人），存在 relay.tenants.features 的 ai_wake_limit，不新增資料表。
-- 內容：
--  1. relay.room_ai_wake_limit(群組)：主持人帳號的上限；沒設定＝5。
--  2. relay.room_ai_chain_blocked(群組, 發言者鍵)：這則 AI 發言若點名 AI，會不會超過上限。
--  3. asn_relay_room_post：以 20261023170100 的定義為底，AI 發言先查上限，超過就把被點名的 AI 全部記進 suppressed，且不佔叫醒額度。
--  4. asn_account_settings(使用者, 上限)：讀／改帳號設定（電腦版與手機版設定頁用，Edge 的 account_settings 動作呼叫）。
-- 回復：把 20261023170100 裡的 asn_relay_room_post 定義再套一次；兩個 relay 函式與 asn_account_settings 可留著不影響。
begin;

create or replace function relay.room_ai_wake_limit(p_room text)
 returns integer language sql stable security definer set search_path to ''
as $function$
  select coalesce(
    (select case when (t.features->>'ai_wake_limit') ~ '^[0-9]{1,2}$' then least((t.features->>'ai_wake_limit')::int, 20) end
     from relay.tenants t where t.owner_user = relay.room_host(p_room)),
    5);
$function$;

create or replace function relay.room_ai_chain_blocked(p_room text, p_sender text)
 returns boolean language sql stable security definer set search_path to ''
as $function$
  select (
    select count(*) from relay.room_messages m
    where m.room_id = p_room and not m.is_seed
      and m.seq > coalesce((select max(h.seq) from relay.room_messages h
                            where h.room_id = p_room and not h.is_seed and relay.msg_kind(h.from_kind, h.from_member, h.trust) = 'human'), 0)
      and relay.msg_kind(m.from_kind, m.from_member, m.trust) = 'ai'
      and exists (select 1 from unnest(m.mentions) k where k <> '~owner' and k not like '~u:%')
  ) >= relay.room_ai_wake_limit(p_room);
$function$;

create or replace function public.asn_relay_room_post(p_node text, p_agent text, p_room text, p_body text, p_mentions text[], p_owner boolean DEFAULT false, p_signed_user uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_key text := relay.room_actor_key(p_node, p_agent, p_owner, p_signed_user, p_room);
  v_trust text;
  v_seq bigint;
  v_mentions text[];
  v_recent int;
  v_rt uuid;
  v_st uuid;
  v_sup text[];
  v_human boolean;
  v_limited boolean := false;
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_body is null or char_length(p_body) < 1 or char_length(p_body) > 20000 then
    return jsonb_build_object('error', 'bad_body');
  end if;
  if not relay.room_can(p_room, p_node, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  if not p_owner and p_agent is not null and btrim(p_agent) <> ''
     and not exists (select 1 from relay.roster where node = p_node and name = p_agent) then
    return jsonb_build_object('error', 'unknown_agent');
  end if;
  if v_key <> '~owner' then
    select count(*) into v_recent from relay.room_messages
      where room_id = p_room and from_member = v_key and at > now() - interval '1 hour'
        and not is_seed and from_kind is distinct from 'system';
    if v_recent >= 20 then
      return jsonb_build_object('error', 'rate_limited');
    end if;
  end if;
  v_trust := case when p_owner or public.asn_user_owns_node(p_signed_user, p_node)
                  then 'owner' else 'member' end;
  select coalesce(array_agg(s.m), array[]::text[]) into v_mentions from (
    select distinct q.rk as m from (
      select relay.room_resolve_key(p_room, x) as rk from unnest(coalesce(p_mentions, array[]::text[])) x
    ) q
    where q.rk is not null and q.rk <> v_key and relay.room_is_member(p_room, q.rk) order by q.rk limit 8
  ) s;
  select tenant_id into v_rt from relay.rooms where id = p_room;
  v_st := relay.member_tenant(v_key, v_rt);
  v_human := v_trust = 'owner' or v_key = '~owner' or v_key like '~u:%';
  -- AI 發言：本輪之前已經叫醒了上限那麼多輪，就不再叫醒被點名的 AI（真人、主持人的點名不受影響）
  if not v_human and relay.room_ai_chain_blocked(p_room, v_key) then
    select coalesce(array_agg(k), array[]::text[]) into v_sup from unnest(v_mentions) k
      where k <> '~owner' and k not like '~u:%';
    v_limited := coalesce(array_length(v_sup, 1), 0) > 0;
  else
    v_sup := relay.room_wake_filter(p_room, v_st, v_rt, v_mentions);
  end if;
  v_seq := relay.room_append(p_room, v_key, v_trust, p_body, v_mentions, case when v_human then 'human' else 'ai' end, false,
                             (select t.owner_user from relay.tenants t where t.id = v_st), now(), v_sup);
  update relay.room_members set read_seq = v_seq where room_id = p_room and member = v_key;
  return jsonb_build_object('seq', v_seq, 'from', v_key, 'bell_topics', to_jsonb(relay.room_bells(p_room)), 'suppressed', to_jsonb(v_sup),
                            'wake_limited', v_limited);
end;
$function$;

-- 帳號設定：p_ai_wake_limit 給了就改（0～20 的整數，其他 bad_request），沒給就讀；沒設過回預設 5
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
    if p_ai_wake_limit not between 0 and 20 then
      return jsonb_build_object('error', 'bad_request');
    end if;
    update relay.tenants set features = coalesce(features, '{}'::jsonb) || jsonb_build_object('ai_wake_limit', p_ai_wake_limit) where id = v_t.id;
    return jsonb_build_object('ai_wake_limit', p_ai_wake_limit);
  end if;
  return jsonb_build_object('ai_wake_limit',
    case when (v_t.features->>'ai_wake_limit') ~ '^[0-9]{1,2}$' then least((v_t.features->>'ai_wake_limit')::int, 20) else 5 end);
end;
$function$;

revoke all on function public.asn_account_settings(uuid, integer) from public, anon, authenticated;
grant execute on function public.asn_account_settings(uuid, integer) to service_role;

commit;
