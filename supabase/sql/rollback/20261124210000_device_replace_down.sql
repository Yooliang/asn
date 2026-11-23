-- 回復 20261124210000_device_replace.sql：set_node_platform 換回上一版本體（20261102170000_node_platform_phone.sql），drop 新函式與兩個欄位。
-- 已經寫進帳號設定 removed 的舊設備鍵、已搬過去的名字、通知與 account_events 紀錄都不動（留著不影響任何舊功能）。
begin;

create or replace function public.asn_relay_set_node_platform(p_node text, p_platform text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if p_platform is null or p_platform not in ('linux', 'windows', 'macos', 'android', 'ios') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.nodes set platform = p_platform where id = p_node and status = 'active' and platform is distinct from p_platform;
  return jsonb_build_object('ok', true);
end;
$function$;
revoke all on function public.asn_relay_set_node_platform(text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_set_node_platform(text, text) to service_role;

drop function if exists public.asn_device_replace_dismiss(uuid, text, text);
drop function if exists public.asn_device_replace(uuid, text, text, text);
drop function if exists public.asn_device_replace_candidates(uuid, text);
drop function if exists relay.new_device_check(text);
drop function if exists relay.device_replace_old_nodes(text);
drop function if exists relay.device_replace_new_within();
drop function if exists relay.device_replace_offline_after();
alter table relay.nodes drop column if exists new_device_noticed_at;
alter table relay.nodes drop column if exists replace_asked_at;

commit;
