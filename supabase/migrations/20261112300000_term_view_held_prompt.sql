-- 遠端打字遇到「需要本人確認的外來訊息框」時結束的原因 held_prompt（#1254 A）。
-- 被看的那台（T）偵測到窗格停在這種框，就結束這次遠端打字，回報 held_prompt；看的那台顯示「對方畫面出現需要本人確認的框，遠端輸入已停止」。
-- 只改兩處：relay.term_views 的 end_reason 檢查式多收 held_prompt；asn_relay_term_view_stop 的原因清單多收 held_prompt。
-- 其餘一字不改：security definer、search_path 空、授權照舊；碰到的資料表只有 relay.term_views（同上一版）。
-- 舊版電腦端不會送這個原因；新版送了、舊後台不認得（bad_request）時，電腦端改用 failed 結束（見 lib.rs），所以先上哪一邊都不會壞。
-- 部署順序：本 migration → relay（Edge 的 STOP_REASONS 多 held_prompt）→ 新版 ASN。
-- 回復：supabase/sql/rollback/20261112300000_term_view_held_prompt_down.sql（held_prompt 的列先改成 failed，再換回檢查式與函式）。
begin;

alter table relay.term_views drop constraint if exists term_views_reason_check;
alter table relay.term_views add constraint term_views_reason_check check (end_reason is null or end_reason = any (array['expired','viewer_ended','target_ended','rejected','viewer_gone','failed','mobile_off','held_prompt']));

create or replace function public.asn_relay_term_view_stop(p_node text, p_id uuid, p_reason text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_n int;
begin
  if p_id is null or p_reason is null or p_reason not in ('target_ended', 'rejected', 'viewer_gone', 'failed', 'mobile_off', 'held_prompt') then
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
