-- 回復 20261102130000_inbox_watch.sql：取消排程、drop 函式與兩張表。relay.nodes.inbox_hold_until 欄位保留（asn-2 的 #173 也用它）。已寄出的通知信不受影響。
begin;
select cron.unschedule('asn-inbox-watch') where exists (select 1 from cron.job where jobname = 'asn-inbox-watch');
drop function if exists public.asn_relay_inbox_watch(boolean);
drop table if exists relay.inbox_watch_log;
drop table if exists relay.inbox_watch;
commit;
