-- 視窗改名後，同節點在群組裡的成員記錄跟著改名（#229）。
-- 成員鍵是「節點~視窗名」，視窗改名後群組仍記舊名，發言回 not_member。後台沒有可靠的「這是改名」訊號可猜，
-- 所以只認兩種明確訊號，不靠名字猜測：
--   1. 用戶端明說「舊名→新名」：asn_relay_window_rename(節點, 舊名, 新名)（電腦版改名、橋偵測到視窗改名）。
--   2. 夥伴同步本來就以 session 辨認「同一位夥伴改名」（夥伴 ID 設計第一期規則 1）：同節點、同 session、現用名變了，
--      觸發器 partner_rename_follow 把這個伺服器自己判定的改名也帶到群組（舊版橋不用改）。接班（session 變）、跨節點、被讓出都不算。
-- 節點只能改自己名下的視窗（鍵一律由節點代號＋視窗名組成，碰不到別的節點）。
--
-- relay.window_rename_members：對每個有舊鍵的群組成員記錄：
--     - 新鍵在同群組已存在：不覆蓋、不合併，保留兩者，計入回傳的 conflicts（Edge 記 log）。
--     - 否則把成員鍵改成新鍵，其餘欄位原樣保留（角色、加入時間、已讀位置、可見起點、allow_others、member_ref、user_id、left_at）；
--       display_name 只有在「沒設或等於舊視窗名」時才跟著改成新視窗名（使用者自訂的顯示名不動）。
--   歷史也一併改鍵（選擇「改鍵」而不是「保留舊鍵加對照表」：讀取函式全以成員表對應顯示名，舊鍵一旦不在成員表就會掉成推算名，
--   改鍵後所有讀取路徑不用動，也不會留下舊名）：room_messages.from_member／mentions／suppressed、room_wakes.target、
--   room_confirms.requester、room_pins.updated_by。訊息內文裡打的 @舊名 是文字，不改。
--   對外代號 x:<member_ref> 不變，跨租戶的人看不到舊名（不寫「某某改名」的系統訊息，免得把舊名送出去）。
-- 可重跑（舊鍵已不存在＝什麼都不改，回 moved=0）；舊版用戶端沒呼叫就維持現狀。
-- 先不套用：部署由負責的 session 處理（順序：本 migration → relay Edge Function → 用戶端）。
-- 回復：drop trigger partner_rename_follow on relay.partners; drop function relay.partner_rename_follow(),
--   public.asn_relay_window_rename(text, text, text), relay.window_rename_members(text, text, text);
--   （已改過的鍵不會自動改回，改回請在回復前再呼叫一次 新名→舊名）
begin;

create or replace function relay.window_rename_members(p_node text, p_from text, p_to text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
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
    update relay.room_confirms set requester = v_new where room_id = r.room_id and requester = v_old;
    update relay.room_pins set updated_by = v_new where room_id = r.room_id and updated_by = v_old;
    v_moved := v_moved + 1;
  end loop;
  return jsonb_build_object('ok', true, 'moved', v_moved, 'conflicts', v_conflicts);
end;
$function$;
revoke all on function relay.window_rename_members(text, text, text) from public, anon, authenticated;

-- 用戶端明說的改名。節點取自金鑰，只准動自己名下的視窗
create or replace function public.asn_relay_window_rename(p_node text, p_from text, p_to text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active') then
    return jsonb_build_object('error', 'forbidden');
  end if;
  return relay.window_rename_members(p_node, p_from, p_to);
end;
$function$;
revoke all on function public.asn_relay_window_rename(text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_window_rename(text, text, text) to service_role;

-- 夥伴同步判定的改名（同節點、同 session、現用名變了）帶到群組。出任何錯只記警告，不擋夥伴同步
create or replace function relay.partner_rename_follow()
 returns trigger language plpgsql security definer set search_path to ''
as $function$
begin
  if old.current_name is not null and new.current_name is not null and old.current_name <> new.current_name
     and old.node = new.node and old.current_session is not distinct from new.current_session then
    perform relay.window_rename_members(new.node, old.current_name, new.current_name);
  end if;
  return new;
exception when others then
  raise warning 'partner_rename_follow failed: %', sqlerrm;
  return new;
end;
$function$;
drop trigger if exists partner_rename_follow on relay.partners;
create trigger partner_rename_follow after update of current_name on relay.partners
  for each row when (old.current_name is distinct from new.current_name) execute function relay.partner_rename_follow();

commit;
