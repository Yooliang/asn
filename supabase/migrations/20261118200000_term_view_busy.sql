-- 遠端打字被拒時，如果是因為被打字那台畫面上還有沒處理的確認框，結束原因記 busy（#1303）。
-- 發起端看到「那台有另一個確認還沒處理」，而不是和「沒有接受」混在一起。
-- 只改兩處：relay.term_views 的 end_reason 檢查式多收 busy；asn_relay_term_view_stop 的原因清單多收 busy。
-- 其餘一字不改：security definer、search_path 空、授權照舊；碰到的資料表只有 relay.term_views（同上一版 20261112300000）。
-- 舊版電腦端不會送這個原因；新版送了、舊後台不認得（bad_request）時，電腦端改用 rejected 結束，所以先上哪一邊都不會壞。
-- 部署順序：本 migration → relay（Edge 的 STOP_REASONS 多 busy）→ 新版 ASN。
-- 回復：supabase/sql/rollback/20261118200000_term_view_busy_down.sql（busy 的列先改成 rejected，再換回檢查式與函式）。
begin;

alter table relay.term_views drop constraint if exists term_views_reason_check;
alter table relay.term_views add constraint term_views_reason_check check (end_reason is null or end_reason = any (array['expired','viewer_ended','target_ended','rejected','viewer_gone','failed','mobile_off','held_prompt','busy']));

create or replace function public.asn_relay_term_view_stop(p_node text, p_id uuid, p_reason text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_n int;
begin
  if p_id is null or p_reason is null or p_reason not in ('target_ended', 'rejected', 'viewer_gone', 'failed', 'mobile_off', 'held_prompt', 'busy') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.term_views
    set status = 'ended', end_reason = p_reason, ended_at = now(), topic = null, d_eph_pub = null, d_sig = null, t_eph_pub = null, t_sig = null
    where id = p_id and to_node = p_node and status <> 'ended';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;
revoke all on function public.asn_relay_term_view_stop(text, uuid, text) from public, anon, authenticated;
grant execute on function public.asn_relay_term_view_stop(text, uuid, text) to service_role;

commit;
