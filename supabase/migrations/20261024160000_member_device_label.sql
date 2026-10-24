-- 群組成員／發言者的顯示標示改用「夥伴名（設備名）」（小良哥 10-24：自己名下的夥伴括號裡全是同一個主人名，沒有資訊量）。
-- 規則（唯一的真相放在這裡，用戶端與 parseMentions 都只拿後台算好的字串）：
--   真人＝帳號名（不變）；讀者自己帳號下的夥伴＝「夥伴名（設備名）」，設備名取不到（或與夥伴名相同）就只有夥伴名，絕不顯示節點代號；
--   別的帳號的夥伴＝「夥伴名（帳號主人名）」（與舊標示相同）。外部成員一律不給設備名，不外洩別人帳號的設備資訊。
-- 內容（全部加欄位，不改既有欄位的值，舊用戶端照舊顯示 label／from_label）：
--  1. relay.room_display_label(群組, 成員鍵, 讀者租戶, 群組租戶, 是否 AI)：上述規則。
--  2. relay.room_members_view：每位成員多 display_label。
--  3. relay.room_quote：多 from_display_label。
--  4. asn_relay_group_read：每則多 from_display_label。
--  後台從內文解析 @名字（_shared/rooms.ts parseMentions）同時認 label 與 display_label，所以新舊標示打出來的點名都解析得到同一位成員。
-- 回復：把 20261023180000 的 room_members_view、20261024140000 的 room_quote、20261024150000 的 asn_relay_group_read 定義再套一次；room_display_label 可留著不影響。
begin;

create or replace function relay.room_display_label(p_room text, p_member text, p_reader uuid, p_rt uuid, p_ai boolean)
 returns text language sql stable security definer set search_path to ''
as $function$
  select case
    when not p_ai then relay.room_display_name(p_room, p_member)
    when relay.member_tenant(p_member, p_rt) is not distinct from p_reader then
      relay.room_display_name(p_room, p_member) || coalesce((
        select '（' || nullif(btrim(n.name), '') || '）' from relay.nodes n
        where p_member not like '~%' and n.id = split_part(p_member, '~', 1)
          and nullif(btrim(n.name), '') is distinct from relay.room_display_name(p_room, p_member)), '')
    else relay.room_display_name(p_room, p_member) || '（' || coalesce(relay.room_owner_name(p_member, p_rt), '?') || '）'
  end;
$function$;

create or replace function relay.room_members_view(p_room text, p_reader uuid)
 returns jsonb language sql stable security definer set search_path to ''
as $function$
  select coalesce(jsonb_agg(
    case when x.mt is not distinct from p_reader then jsonb_build_object(
      'key', x.member,
      'name', relay.room_display_name(p_room, x.member),
      'role', x.role,
      'kind', case when x.member = '~owner' or x.member like '~u:%' then 'owner'
                   when position('~' in x.member) > 0 then 'window'
                   else coalesce(x.nkind, 'other') end,
      'node_role', case when x.member = '~owner' or x.member like '~u:%' then 'owner' else coalesce(x.nrole, 'member') end,
      'joined_via', x.joined_via,
      'member_kind', case when x.member = '~owner' or x.member like '~u:%' then 'human' else 'ai' end,
      'owner_name', relay.room_owner_name(x.member, x.rt),
      'label', case when x.member = '~owner' or x.member like '~u:%' then relay.room_display_name(p_room, x.member)
                    else relay.room_display_name(p_room, x.member) || '（' || coalesce(relay.room_owner_name(x.member, x.rt), '?') || '）' end,
      'display_label', relay.room_display_label(p_room, x.member, p_reader, x.rt, not (x.member = '~owner' or x.member like '~u:%')),
      'allow_others', case when x.member = '~owner' or x.member like '~u:%' then null else x.allow_others end,
      'mine', true)
    else jsonb_build_object(
      'key', 'x:' || x.member_ref::text,
      'name', relay.room_display_name(p_room, x.member),
      'role', x.role,
      'kind', case when x.member = '~owner' or x.member like '~u:%' then 'human' else 'ai' end,
      'member_kind', case when x.member = '~owner' or x.member like '~u:%' then 'human' else 'ai' end,
      'owner_name', relay.room_owner_name(x.member, x.rt),
      'label', case when x.member = '~owner' or x.member like '~u:%' then relay.room_display_name(p_room, x.member)
                    else relay.room_display_name(p_room, x.member) || '（' || coalesce(relay.room_owner_name(x.member, x.rt), '?') || '）' end,
      'display_label', relay.room_display_label(p_room, x.member, p_reader, x.rt, not (x.member = '~owner' or x.member like '~u:%')),
      'allow_others', case when x.member = '~owner' or x.member like '~u:%' then null else x.allow_others end,
      'mine', false)
    end order by x.joined_at, x.member), '[]'::jsonb)
  from (
    select m.member, m.member_ref, m.role, m.joined_at, m.joined_via, r.tenant_id as rt,
           relay.member_tenant(m.member, r.tenant_id) as mt, n.kind as nkind, n.role as nrole, m.allow_others
    from relay.room_members m
    join relay.rooms r on r.id = m.room_id
    left join relay.nodes n on n.id = split_part(m.member, '~', 1) and m.member not like '~%'
    where m.room_id = p_room and m.left_at is null
  ) x;
$function$;

create or replace function relay.room_quote(p_room text, p_seq bigint, p_vis bigint, p_reader uuid, p_rt uuid)
 returns jsonb language sql stable security definer set search_path to ''
as $function$
  select jsonb_build_object(
    'seq', q.seq,
    'from', relay.room_ext_key(p_room, q.from_member, p_reader, p_rt),
    'from_kind', relay.msg_kind(q.from_kind, q.from_member, q.trust),
    'from_label', case when relay.msg_kind(q.from_kind, q.from_member, q.trust) = 'ai'
        then relay.room_display_name(p_room, q.from_member) || '（' || coalesce(relay.room_owner_name(q.from_member, p_rt), '?') || '）'
        else relay.room_display_name(p_room, q.from_member) end,
    'from_display_label', relay.room_display_label(p_room, q.from_member, p_reader, p_rt, relay.msg_kind(q.from_kind, q.from_member, q.trust) = 'ai'),
    'excerpt', left(btrim(regexp_replace(regexp_replace(q.body, '^↩ 回覆 [^' || chr(10) || ']*' || chr(10) || '?', ''), '\s+', ' ', 'g')), 80))
  from relay.room_messages q
  where p_seq is not null and q.room_id = p_room and q.seq = p_seq
    and q.seq > coalesce(p_vis, 0)
    and q.from_kind is distinct from 'system';
$function$;

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
      'from_display_label', relay.room_display_label(p_room, s.from_member, v_reader, v_rt, relay.msg_kind(s.from_kind, s.from_member, s.trust) = 'ai'),
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

revoke all on function relay.room_display_label(text, text, uuid, uuid, boolean) from public, anon, authenticated;

commit;
