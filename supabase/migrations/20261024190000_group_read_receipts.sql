-- 群組訊息的「已讀 N」（#224）：後台每位成員已有 read_seq（讀到哪一則）。一則訊息的已讀人數＝除發言者外、這則對他可見
-- （seq 大於他的 visible_from_seq）的有效成員（沒離開群組）中，read_seq ≥ 該則 seq 的人數；真人與 AI 都算（AI 的 read_seq 要等它的橋讀取後才前進，是已知特性）。
-- 內容（全部是加欄位，舊用戶端忽略）：
--  1. relay.receipt_members(群組, 讀者租戶, 群組租戶)：一次把成員的 read_seq／可見起點／顯示標示（沿用 room_display_label，別租戶的 AI 加（主人名），不含節點代號）整理成 jsonb，
--     asn_relay_group_read 整批訊息共用這一份，不為每則訊息各查一次。
--  2. relay.receipt_of(成員表, 序號, 發言者, 是否讀者這邊發的)：回 read_count、read_total；讀者這邊發的另有 read_by／unread_by（名字清單，給電腦版滑鼠提示）。
--  3. asn_relay_group_read：每則非系統、非開頭紀錄的訊息多帶上面的欄位；回應多帶 reads＝讀者這邊最近 40 則內發的訊息的已讀狀況（沒有新訊息時畫面靠它更新）。
-- 回復：把 20261024160000 的 asn_relay_group_read 定義再套一次；新函式可留著不影響。
begin;

create or replace function relay.receipt_members(p_room text, p_reader uuid, p_rt uuid)
 returns jsonb language sql stable security definer set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
      'm', m.member, 'rs', m.read_seq, 'vf', m.visible_from_seq,
      'l', relay.room_display_label(p_room, m.member, p_reader, p_rt, not (m.member = '~owner' or m.member like '~u:%'))
    ) order by m.joined_at, m.member), '[]'::jsonb)
  from relay.room_members m
  where m.room_id = p_room and m.left_at is null;
$function$;

create or replace function relay.receipt_of(p_mem jsonb, p_seq bigint, p_from text, p_names boolean)
 returns jsonb language sql immutable set search_path to ''
as $function$
  select jsonb_build_object('read_count', count(*) filter (where x.rs >= p_seq), 'read_total', count(*))
    || case when p_names then jsonb_build_object(
         'read_by', coalesce(jsonb_agg(x.l order by x.ord) filter (where x.rs >= p_seq), '[]'::jsonb),
         'unread_by', coalesce(jsonb_agg(x.l order by x.ord) filter (where x.rs < p_seq), '[]'::jsonb))
       else '{}'::jsonb end
  from (select e.v->>'m' as m, (e.v->>'rs')::bigint as rs, (e.v->>'vf')::bigint as vf, e.v->>'l' as l, e.ord
        from jsonb_array_elements(p_mem) with ordinality as e(v, ord)) x
  where x.m <> p_from and coalesce(x.vf, 0) < p_seq;
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
  v_mem jsonb;
  v_reads jsonb;
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
  v_mem := relay.receipt_members(p_room, v_reader, v_rt);
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
    ) || case when s.from_kind is distinct from 'system' and not s.is_seed
              then relay.receipt_of(v_mem, s.seq, s.from_member, relay.member_tenant(s.from_member, v_rt) is not distinct from v_reader)
              else '{}'::jsonb end
      order by s.seq), '[]'::jsonb), max(s.seq)
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
  -- 讀者自己這一邊發的最近幾則的已讀狀況（不論這次有沒有讀到它們）：讓畫面在沒有新訊息時也能更新「已讀 N」
  select coalesce(jsonb_agg(jsonb_build_object('seq', m.seq) || relay.receipt_of(v_mem, m.seq, m.from_member, true) order by m.seq), '[]'::jsonb)
    into v_reads
  from relay.room_messages m
  where m.room_id = p_room and m.seq > greatest(coalesce(v_vis, 0), coalesce(v_last, 0) - 40)
    and not m.is_seed and m.from_kind is distinct from 'system'
    and relay.member_tenant(m.from_member, v_rt) is not distinct from v_reader;
  return jsonb_build_object('messages', v_msgs, 'last_seq', v_last, 'key', v_key, 'reads', v_reads);
end;
$function$;

revoke all on function relay.receipt_members(text, uuid, uuid) from public, anon, authenticated;
revoke all on function relay.receipt_of(jsonb, bigint, text, boolean) from public, anon, authenticated;

commit;
