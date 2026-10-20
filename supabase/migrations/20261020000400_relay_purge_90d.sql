-- 訊息保存 90 天（同 31_relay_purge_90d.sql）：每天 03:17（UTC）刪除超過 90 天的一對一與群組訊息，群組置頂不刪。
create extension if not exists pg_cron;
select cron.unschedule('relay-purge-90d') where exists (select 1 from cron.job where jobname = 'relay-purge-90d');
select cron.schedule('relay-purge-90d', '17 3 * * *', $$
  delete from relay.messages where created_at < now() - interval '90 days';
  delete from relay.room_messages where at < now() - interval '90 days';
$$);
