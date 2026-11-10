-- 回復檔（不是 migration，不會被部署；要用時人工執行）。
-- 回復 20261112300000_term_view_held_prompt.sql：已記成 held_prompt 的觀看改記 failed（檢查式才換得回去；只是結束原因的標籤，不刪任何列），
-- 再把檢查式與 asn_relay_term_view_stop 逐字換回 20261109120000_mobile_view_platform.sql 的版本。
begin;

update relay.term_views set end_reason = 'failed' where end_reason = 'held_prompt';
alter table relay.term_views drop constraint if exists term_views_reason_check;
alter table relay.term_views add constraint term_views_reason_check check (end_reason is null or end_reason = any (array['expired','viewer_ended','target_ended','rejected','viewer_gone','failed','mobile_off']));

create or replace function public.asn_relay_term_view_stop(p_node text, p_id uuid, p_reason text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_n int;
begin
  if p_id is null or p_reason is null or p_reason not in ('target_ended', 'rejected', 'viewer_gone', 'failed', 'mobile_off') then
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
