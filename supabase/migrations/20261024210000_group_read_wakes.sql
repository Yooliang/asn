-- 晚到的叫醒順序（wake_info）補上：順序是「第一位 AI 讀者讀到時才算並存回」（要打 Jev，延遲數秒到一分鐘），
-- 發言者的用戶端在訊息一發出就讀到，當時還是 null，之後不重抓舊訊息所以標籤永遠不出現。
-- 內容（全部是加欄位，舊用戶端忽略）：asn_relay_group_read 回應多帶 wakes＝最近 40 則內（讀者看得到、非系統、非開頭紀錄）
--  已有 wake_info 的 [{seq, wake_info}]，wake_info 走既有的 wake_view（可見性與對外代號不變）。只讀已存結果，不寫入、不標已讀。
-- 回復：把 20261024190000 的 asn_relay_group_read 定義再套一次。
begin;

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
  v_wakes jsonb;
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
  -- 最近 40 則中已有叫醒順序（wake_info）的訊息：順序是第一位 AI 讀者讀到時才算並存回，用戶端比 AI 先讀到的訊息要靠它補上。
  -- 只讀已存的結果（不觸發任何計算）；標示一律走 wake_view（讀者看得到的成員、別租戶只看到對外代號）
  select coalesce(jsonb_agg(jsonb_build_object('seq', m.seq, 'wake_info', relay.wake_view(p_room, m.wake_info, v_reader, v_rt)) order by m.seq), '[]'::jsonb)
    into v_wakes
  from relay.room_messages m
  where m.room_id = p_room and m.seq > greatest(coalesce(v_vis, 0), coalesce(v_last, 0) - 40)
    and not m.is_seed and m.from_kind is distinct from 'system'
    and m.wake_info is not null and jsonb_typeof(m.wake_info) = 'array';
  return jsonb_build_object('messages', v_msgs, 'last_seq', v_last, 'key', v_key, 'reads', v_reads, 'wakes', v_wakes);
end;
$function$;

commit;
