-- 視窗改名時，訊息上已存的叫醒順序（wake_info 裡的成員鍵 m）也要跟著改成新名字。
-- 原因：wake_view 用成員鍵去對現在還在群組的成員；改名後舊鍵對不到人，那一格順序標籤就整個消失
--（小良哥 2026-10-25 問「正見VM 群組怎麼沒有 jev 順序」：asn-2 改名成 asn西川 後，stored 的 H~asn-2 對不到）。
-- 一、重新定義 relay.window_rename_members（只多一行 wake_info 改寫；其餘與 20261024180000 相同）。
-- 二、修復已經掉的紀錄：舊鍵 H~asn-2 → H~asn西川（只在新鍵是該群組現有成員、舊鍵不是時才改）。
-- 回復：把 20261024180000 的 relay.window_rename_members 定義再套一次；已改寫的 wake_info 不需要還原（新鍵本來就是現在的成員）。
begin;

CREATE OR REPLACE FUNCTION relay.window_rename_members(p_node text, p_from text, p_to text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_old text;
  v_new text;
  r record;
  v_moved int := 0;
  v_conflicts int := 0;
begin
  if p_from is null or p_to is null
     or char_length(btrim(p_from)) not between 1 and 60 or char_length(btrim(p_to)) not between 1 and 60
     or position('~' in p_from) > 0 or position('~' in p_to) > 0 or p_from = p_to then
    return jsonb_build_object('error', 'bad_request');
  end if;
  v_old := p_node || '~' || p_from;
  v_new := p_node || '~' || p_to;
  for r in select m.room_id, m.display_name from relay.room_members m where m.member = v_old order by m.room_id for update loop
    if exists (select 1 from relay.room_members x where x.room_id = r.room_id and x.member = v_new) then
      v_conflicts := v_conflicts + 1;
      continue;
    end if;
    update relay.room_members
      set member = v_new,
          display_name = case when nullif(btrim(r.display_name), '') is null or r.display_name = p_from then p_to else r.display_name end
      where room_id = r.room_id and member = v_old;
    update relay.room_messages set from_member = v_new where room_id = r.room_id and from_member = v_old;
    update relay.room_messages set mentions = array_replace(mentions, v_old, v_new) where room_id = r.room_id and v_old = any(mentions);
    update relay.room_messages set suppressed = array_replace(suppressed, v_old, v_new) where room_id = r.room_id and v_old = any(suppressed);
    update relay.room_wakes set target = v_new where room_id = r.room_id and target = v_old;
    update relay.room_messages set wake_info = (select jsonb_agg(case when e.v->>'m' = v_old then jsonb_set(e.v, '{m}', to_jsonb(v_new)) else e.v end order by e.ord) from jsonb_array_elements(wake_info) with ordinality as e(v, ord)) where room_id = r.room_id and jsonb_typeof(wake_info) = 'array' and wake_info @> jsonb_build_array(jsonb_build_object('m', v_old));
    update relay.room_confirms set requester = v_new where room_id = r.room_id and requester = v_old;
    update relay.room_pins set updated_by = v_new where room_id = r.room_id and updated_by = v_old;
    v_moved := v_moved + 1;
  end loop;
  return jsonb_build_object('ok', true, 'moved', v_moved, 'conflicts', v_conflicts);
end;
$function$;

-- 修復已掉的順序標籤：舊鍵 H~asn-2 → 新鍵 H~asn西川
update relay.room_messages mm set wake_info = (
    select jsonb_agg(case when e.v->>'m' = 'H~asn-2' then jsonb_set(e.v, '{m}', to_jsonb('H~asn西川'::text)) else e.v end order by e.ord)
    from jsonb_array_elements(mm.wake_info) with ordinality as e(v, ord))
 where jsonb_typeof(mm.wake_info) = 'array'
   and mm.wake_info @> jsonb_build_array(jsonb_build_object('m', 'H~asn-2'))
   and exists (select 1 from relay.room_members x where x.room_id = mm.room_id and x.member = 'H~asn西川' and x.left_at is null)
   and not exists (select 1 from relay.room_members x where x.room_id = mm.room_id and x.member = 'H~asn-2' and x.left_at is null);

commit;
