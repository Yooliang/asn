-- 群組訊息下方的順序標籤（#231）：叫醒判斷（含 Jev 分數）第一次算出時，把「依序被叫醒的夥伴與被略過者」存在訊息上，之後所有成員讀到同一份。
-- 內容：
--  1. relay.room_messages 多一欄 wake_info（jsonb，選填）：[{ m: 成員真實鍵, rank, hold, score }]。只存順序與是否略過，不存內文。
--  2. 新函式 asn_relay_room_wake_set(節點, 視窗, 群組, 序號, 資訊, …)：呼叫者必須是群組成員；資訊裡的成員鍵可以是讀者視角的對外代號（x:…），
--     這裡還原成真實鍵並只留現有成員；「只在尚未有值時寫入」（where wake_info is null），所以多位讀者同時算也只有第一份會留下，不會被覆蓋。
--  3. relay.wake_view(群組, 資訊, 讀者租戶, 群組租戶)：轉成讀者看得到的版本——只列現在還在群組的成員，成員鍵用 room_ext_key（別租戶是 x: 對外代號，
--     不含節點代號），標示＝顯示名（別租戶的成員加「（主人名）」），依順序排、被略過的排最後；不回分數。
--  4. asn_relay_group_read 每則多回 wake_info（沒存過就是 null）；其餘欄位不動，舊用戶端忽略它。
-- 回復：把 20261024140000 的 asn_relay_group_read 定義再套一次；wake_set、wake_view 與 wake_info 欄位可留著不影響。
begin;

alter table relay.room_messages add column if not exists wake_info jsonb;

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
           'score', case when (e.v->>'score') ~ '^[0-9](\.[0-9]+)?$' then to_jsonb((e.v->>'score')::numeric) end
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
  return jsonb_build_object('set', v_n > 0);
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
      ) order by ((e.v->>'hold') = 'true'), (e.v->>'rank')::int, e.ord)
    from jsonb_array_elements(p_info) with ordinality as e(v, ord)
    join relay.room_members rm on rm.room_id = p_room and rm.left_at is null and rm.member = e.v->>'m'
  ), '[]'::jsonb) end;
$function$;

revoke all on function public.asn_relay_room_wake_set(text, text, text, bigint, jsonb, boolean, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_room_wake_set(text, text, text, bigint, jsonb, boolean, uuid) to service_role;
revoke all on function relay.wake_view(text, jsonb, uuid, uuid) from public, anon, authenticated;

create or replace function public.asn_relay_group_read(p_node text, p_agent text, p_room text, p_since bigint, p_limit integer, p_owner boolean, p_tail boolean, p_mark boolean, p_signed_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_key text := relay.room_actor_key(p_node, p_agent, p_owner, p_signed_user, p_room);
  v_read bigint;
  v_vis bigint;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_since bigint;
  v_msgs jsonb;
  v_max bigint;
  v_last bigint;
  v_rt uuid;
  v_reader uuid;
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not relay.room_can(p_room, p_node, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  select r.tenant_id, r.last_seq into v_rt, v_last from relay.rooms r where r.id = p_room;
  v_reader := relay.member_tenant(v_key, v_rt);
  select read_seq, visible_from_seq into v_read, v_vis from relay.room_members where room_id = p_room and member = v_key;
  v_since := coalesce(p_since, case when p_tail then null else v_read end);
  select coalesce(jsonb_agg(jsonb_build_object(
      'seq', s.seq,
      'from', relay.room_ext_key(p_room, s.from_member, v_reader, v_rt),
      'from_name', relay.room_display_name(p_room, s.from_member),
      'trust', case when s.trust = 'owner' and relay.member_tenant(s.from_member, v_rt) is not distinct from v_reader then 'owner' else 'member' end,
      'from_kind', relay.msg_kind(s.from_kind, s.from_member, s.trust),
      'relation', case
        when s.from_kind = 'system' then 'system'
        when relay.member_tenant(s.from_member, v_rt) is not distinct from v_reader
          then case when relay.msg_kind(s.from_kind, s.from_member, s.trust) = 'human' then 'mine' else 'mine_ai' end
        else 'other' end,
      'from_owner_name', case when relay.msg_kind(s.from_kind, s.from_member, s.trust) = 'ai' then relay.room_owner_name(s.from_member, v_rt) end,
      'from_label', case when relay.msg_kind(s.from_kind, s.from_member, s.trust) = 'ai'
        then relay.room_display_name(p_room, s.from_member) || '（' || coalesce(relay.room_owner_name(s.from_member, v_rt), '?') || '）'
        else relay.room_display_name(p_room, s.from_member) end,
      'body', s.body,
      'mentions', (select coalesce(jsonb_agg(relay.room_ext_key(p_room, mk.k, v_reader, v_rt) order by mk.i), '[]'::jsonb)
                   from unnest(s.mentions) with ordinality as mk(k, i)),
      'at', s.at,
      'is_seed', s.is_seed,
      'wake_ok', not (v_key = any(s.suppressed)),
      'reply_to', relay.room_quote(p_room, s.reply_to_seq, v_vis, v_reader, v_rt),
      'wake_info', relay.wake_view(p_room, s.wake_info, v_reader, v_rt)
    ) order by s.seq), '[]'::jsonb), max(s.seq)
  into v_msgs, v_max
  from (
    select * from (
      select m.* from relay.room_messages m
      where m.room_id = p_room and m.seq > coalesce(v_vis, 0) and (v_since is null or m.seq > v_since)
      order by case when v_since is null then -m.seq else m.seq end
      limit v_limit
    ) t
  ) s;
  if v_max is not null and coalesce(p_mark, p_since is null and not coalesce(p_tail, false)) then
    update relay.room_members set read_seq = greatest(read_seq, v_max) where room_id = p_room and member = v_key;
  end if;
  return jsonb_build_object('messages', v_msgs, 'last_seq', v_last, 'key', v_key);
end;
$function$;

commit;
