-- AI 發的、沒有 @ 任何人的訊息也交給排序判斷（Jev）決定叫醒誰（#230）：後台（Edge room_read）對發言者以外的 AI 成員打分，
-- ≥ 門檻者叫醒並有順位，結果存在訊息上（wake_info）。這份 migration 提供資料庫端三件事：
--  1. relay.room_ai_rounds(群組, 截止序號)：「AI 叫醒了別的 AI」的輪數——從最近一則真人發言（截止序號之前）起算，AI 發的訊息只要
--     有 @ 點名 AI，或存下的 wake_info 裡有通過者（hold=false），就算一輪。
--  2. asn_relay_room_ai_chain(節點, 視窗, 群組, 序號, …)：給 Edge 讀信時查「這則之前已經幾輪、上限幾輪」（上限＝主持人帳號的 ai_wake_limit，預設 5，
--     0＝AI 不能互相叫醒）。呼叫者必須是群組成員。
--  3. relay.room_ai_chain_blocked 改用同一套算法（發言時的檢查也把「靠判斷叫醒的輪」算進去，兩邊口徑一致）。
--  4. asn_relay_room_wake_set：多收選填的 lim（達輪數上限而略過）；回傳多帶「存下的版本」wake_info（讀者視角），
--     Edge 以它為準——兩位讀者同時算出不同結果時，輸的人也看到贏的人存下的版本。其餘行為不變（仍只在尚未有值時寫入）。
--  5. relay.wake_view：略過者若是因輪數上限，多回 limited:true；其餘不變。
-- 舊版 Edge 忽略新欄位；新 Edge 遇到沒有這個 migration（查不到輪數／存入沒回版本）一律不叫醒（寧可不叫也不失控）。
-- 回復：把 20261023190000 的 room_ai_chain_blocked、20261024150000 的 wake_set 與 wake_view 定義再套一次；新函式可留著不影響。
begin;

create or replace function relay.room_ai_rounds(p_room text, p_before bigint default null)
 returns integer language sql stable security definer set search_path to ''
as $function$
  select count(*)::int from relay.room_messages m
  where m.room_id = p_room and not m.is_seed
    and (p_before is null or m.seq < p_before)
    and m.seq > coalesce((select max(h.seq) from relay.room_messages h
                          where h.room_id = p_room and not h.is_seed and relay.msg_kind(h.from_kind, h.from_member, h.trust) = 'human'
                            and (p_before is null or h.seq < p_before)), 0)
    and relay.msg_kind(m.from_kind, m.from_member, m.trust) = 'ai'
    and (exists (select 1 from unnest(m.mentions) k where k <> '~owner' and k not like '~u:%')
         or (m.wake_info is not null and jsonb_typeof(m.wake_info) = 'array'
             and exists (select 1 from jsonb_array_elements(m.wake_info) e where e->>'hold' = 'false')));
$function$;

create or replace function relay.room_ai_chain_blocked(p_room text, p_sender text)
 returns boolean language sql stable security definer set search_path to ''
as $function$
  select relay.room_ai_rounds(p_room, null) >= relay.room_ai_wake_limit(p_room);
$function$;

create or replace function public.asn_relay_room_ai_chain(p_node text, p_agent text, p_room text, p_seq bigint, p_owner boolean DEFAULT false, p_signed_user uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_key text := relay.room_actor_key(p_node, p_agent, p_owner, p_signed_user, p_room);
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not relay.room_can(p_room, p_node, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  if p_seq is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  return jsonb_build_object('count', relay.room_ai_rounds(p_room, p_seq), 'limit', relay.room_ai_wake_limit(p_room));
end;
$function$;

create or replace function public.asn_relay_room_wake_set(p_node text, p_agent text, p_room text, p_seq bigint, p_info jsonb, p_owner boolean DEFAULT false, p_signed_user uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_key text := relay.room_actor_key(p_node, p_agent, p_owner, p_signed_user, p_room);
  v_clean jsonb;
  v_n integer;
  v_rt uuid;
  v_stored jsonb;
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not relay.room_can(p_room, p_node, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  if p_seq is null or p_info is null or jsonb_typeof(p_info) <> 'array' or jsonb_array_length(p_info) > 20 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'm', rm.member,
           'rank', case when (e.v->>'rank') ~ '^[0-9]{1,3}$' then (e.v->>'rank')::int else 0 end,
           'hold', coalesce(e.v->>'hold', 'false') = 'true',
           'score', case when (e.v->>'score') ~ '^[0-9](\.[0-9]+)?$' then to_jsonb((e.v->>'score')::numeric) end,
           'lim', case when coalesce(e.v->>'lim', 'false') = 'true' then to_jsonb(true) end
         ) order by e.ord), '[]'::jsonb)
    into v_clean
  from jsonb_array_elements(p_info) with ordinality as e(v, ord)
  join relay.room_members rm on rm.room_id = p_room and rm.left_at is null
    and rm.member = relay.room_resolve_key(p_room, e.v->>'key')
  where jsonb_typeof(e.v) = 'object';
  -- 只在尚未有值時寫入：先到先得，之後的讀者不覆蓋
  update relay.room_messages set wake_info = v_clean
    where room_id = p_room and seq = p_seq and wake_info is null and from_kind is distinct from 'system';
  get diagnostics v_n = row_count;
  -- 回傳存下的版本（讀者視角），讓輸掉競爭的讀者也以第一份為準
  select m.wake_info into v_stored from relay.room_messages m where m.room_id = p_room and m.seq = p_seq;
  select r.tenant_id into v_rt from relay.rooms r where r.id = p_room;
  return jsonb_build_object('set', v_n > 0, 'wake_info', relay.wake_view(p_room, v_stored, relay.member_tenant(v_key, v_rt), v_rt));
end;
$function$;

create or replace function relay.wake_view(p_room text, p_info jsonb, p_reader uuid, p_rt uuid)
 returns jsonb language sql stable security definer set search_path to ''
as $function$
  select case when p_info is null or jsonb_typeof(p_info) <> 'array' then null else coalesce((
    select jsonb_agg(jsonb_build_object(
        'key', relay.room_ext_key(p_room, rm.member, p_reader, p_rt),
        'label', relay.room_display_name(p_room, rm.member)
                 || case when relay.member_tenant(rm.member, p_rt) is distinct from p_reader
                         then '（' || coalesce(relay.room_owner_name(rm.member, p_rt), '?') || '）' else '' end,
        'rank', (e.v->>'rank')::int,
        'hold', (e.v->>'hold') = 'true'
      ) || case when coalesce(e.v->>'lim', 'false') = 'true' then jsonb_build_object('limited', true) else '{}'::jsonb end
      order by ((e.v->>'hold') = 'true'), (e.v->>'rank')::int, e.ord)
    from jsonb_array_elements(p_info) with ordinality as e(v, ord)
    join relay.room_members rm on rm.room_id = p_room and rm.left_at is null and rm.member = e.v->>'m'
  ), '[]'::jsonb) end;
$function$;

revoke all on function relay.room_ai_rounds(text, bigint) from public, anon, authenticated;
revoke all on function public.asn_relay_room_ai_chain(text, text, text, bigint, boolean, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_room_ai_chain(text, text, text, bigint, boolean, uuid) to service_role;
revoke all on function public.asn_relay_room_wake_set(text, text, text, bigint, jsonb, boolean, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_room_wake_set(text, text, text, bigint, jsonb, boolean, uuid) to service_role;

commit;
