-- #119：AI 永遠可以被點名。以前主人可以對某個 AI 關掉「接受別人點名」（relay.room_members.allow_others），
-- 小良哥 2026-10-25 要的是永遠可被點名，所以後端叫醒判斷不再讀這個欄位；欄位本身保留（舊版 App 還會顯示勾選，
-- 但設成 false 也不再生效）。
-- 套用前現況：沒有任何現有成員是 false（查過 12 位現有成員，0 筆）；仍保險地把殘留的 false 一律改回 true。
-- 其餘叫醒限制不動：同一帳號底下的發言不過濾；別的帳號點名時，每位每群組每小時 10 次、每位全部群組每小時 30 次的額度照舊。
-- 回復：把 20261023170000_groups_p1a_schema.sql 的 relay.room_wake_filter 定義再套一次。
begin;

update relay.room_members set allow_others = true where not allow_others;

create or replace function relay.room_wake_filter(p_room text, p_sender_tenant uuid, p_room_tenant uuid, p_mentions text[])
 returns text[]
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  k text;
  v_out text[] := '{}';
begin
  foreach k in array coalesce(p_mentions, '{}') loop
    if k = '~owner' or k like '~u:%' then continue; end if;
    if relay.member_tenant(k, p_room_tenant) is not distinct from p_sender_tenant then continue; end if;
    if (select count(*) from relay.room_wakes w where w.target = k and w.room_id = p_room and w.at > now() - interval '1 hour') >= 10
       or (select count(*) from relay.room_wakes w where w.target = k and w.at > now() - interval '1 hour') >= 30 then
      v_out := v_out || k;
    else
      insert into relay.room_wakes (room_id, target, from_tenant) values (p_room, k, p_sender_tenant);
    end if;
  end loop;
  return v_out;
end;
$function$;

commit;
