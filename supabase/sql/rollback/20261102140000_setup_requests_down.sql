-- 回復 20261102140000_setup_requests.sql：取消每日清理排程、drop 四支函式與請求表。已送出的登入網址密碼請求不受影響。
begin;
select cron.unschedule('asn-setup-requests-purge') where exists (select 1 from cron.job where jobname = 'asn-setup-requests-purge');
drop function if exists public.asn_setup_request(uuid, text);
drop function if exists public.asn_setup_status(uuid);
drop function if exists public.asn_relay_setup_poll(text, text);
drop function if exists relay.setup_version_ok(text);
drop function if exists public.asn_relay_setup_result(text, boolean, text, text);
drop table if exists relay.setup_requests;
commit;
