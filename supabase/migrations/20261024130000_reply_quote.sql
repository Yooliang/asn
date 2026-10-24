-- 針對某則訊息回覆（#225）：群組訊息可以帶「回覆哪一則」（reply_to_seq），讀取時由後台算出原作者與一行摘要，用戶端據此畫引用並可點回原訊息。
-- 內容：
--  1. relay.room_messages 多一欄 reply_to_seq（選填，同一個群組內的序號；沒有外鍵，原訊息永遠不會被刪，指不到的當沒有引用）。
--  2. relay.room_quote(群組, 序號, 讀者可見起點, 讀者租戶, 群組租戶)：回 { seq, from, from_kind, from_label, excerpt }；
--     原訊息在讀者加入之前（看不到）、不存在、是系統訊息時回 null，所以引用不會洩漏讀者本來看不到的內容。
--     摘要＝原內文去掉開頭的「↩ 回覆」引用行、空白壓成一個、最多 80 字。別租戶的原作者對讀者是 x: 對外代號，不含節點代號。
--  3. 新函式 asn_relay_room_post_reply（比 asn_relay_room_post 多一個 p_reply_to_seq）：序號有效才記；並自動把原作者記進 mentions
--     （自己不點自己、仍受 8 位與成員檢查限制）。asn_relay_room_post 與它的改名守門、回復腳本完全不動，舊 Edge 與舊呼叫端照舊可用。
--  4. asn_relay_group_read 每則多回 reply_to（沒有就是 null）；其餘欄位不動，舊用戶端忽略它。
-- 回復：把 20261023170100 的 asn_relay_group_read 定義再套一次；asn_relay_room_post_reply、reply_to_seq 欄位與 room_quote 可留著不影響。
begin;

alter table relay.room_messages add column if not exists reply_to_seq bigint;

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
    'excerpt', left(btrim(regexp_replace(regexp_replace(q.body, '^↩ 回覆 [^' || chr(10) || ']*' || chr(10) || '?', ''), '\s+', ' ', 'g')), 80))
  from relay.room_messages q
  where p_seq is not null and q.room_id = p_room and q.seq = p_seq
    and q.seq > coalesce(p_vis, 0)
    and q.from_kind is distinct from 'system';
$function$;

-- 回覆版發言：asn_relay_room_post 的定義（20261023190000）一個字都不動，這裡只在外面包一層——
-- 先查原作者並併進點名、交給原函式寫入（成員檢查、頻率、叫醒額度都由它處理）、成功後記下 reply_to_seq。
-- 同一個函式內完成，要嘛全成要嘛全不成。序號不是這個群組裡的一般訊息就當沒有引用（訊息照樣寫入）。
create or replace function public.asn_relay_room_post_reply(p_node text, p_agent text, p_room text, p_body text, p_mentions text[], p_owner boolean DEFAULT false, p_signed_user uuid DEFAULT NULL::uuid, p_reply_to_seq bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_key text := relay.room_actor_key(p_node, p_agent, p_owner, p_signed_user, p_room);
  v_reply bigint;
  v_reply_from text;
  v_mentions text[] := coalesce(p_mentions, array[]::text[]);
  v_res jsonb;
begin
  if v_key is not null and p_reply_to_seq is not null and relay.room_can(p_room, p_node, v_key) then
    select m.seq, m.from_member into v_reply, v_reply_from from relay.room_messages m
      where m.room_id = p_room and m.seq = p_reply_to_seq and m.from_kind is distinct from 'system';
  end if;
  -- AUTO_MENTION_START
  if v_reply_from is not null and v_reply_from <> v_key and not (v_reply_from = any(v_mentions)) then
    -- 原函式最多收 8 位；自動點名排在最前面，免得被使用者自己打的點名擠掉
    v_mentions := array_prepend(v_reply_from, v_mentions);
  end if;
  -- AUTO_MENTION_END
  v_res := public.asn_relay_room_post(p_node, p_agent, p_room, p_body, v_mentions, p_owner, p_signed_user);
  if v_reply is not null and v_res ? 'seq' then
    update relay.room_messages set reply_to_seq = v_reply where room_id = p_room and seq = (v_res->>'seq')::bigint;
  end if;
  return v_res;
end;
$function$;

revoke all on function public.asn_relay_room_post_reply(text, text, text, text, text[], boolean, uuid, bigint) from public, anon, authenticated;
grant execute on function public.asn_relay_room_post_reply(text, text, text, text, text[], boolean, uuid, bigint) to service_role;
revoke all on function relay.room_quote(text, bigint, bigint, uuid, uuid) from public, anon, authenticated;

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
      'reply_to', relay.room_quote(p_room, s.reply_to_seq, v_vis, v_reader, v_rt)
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
