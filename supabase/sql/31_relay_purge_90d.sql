-- 31_relay_purge_90d.sql：訊息保存 90 天（隱私權政策「三、保存期間」的依據）。
-- 每天 03:17（UTC）刪除寄出超過 90 天的一對一訊息與群組訊息。群組置頂（room_pins）不刪。
-- 2026-10-20 已在 Irori 的 Supabase 專案（目前的收發室後台）手動套用；搬到 asn 專案時要一併建立。可重複執行。
select cron.unschedule('relay-purge-90d') where exists (select 1 from cron.job where jobname = 'relay-purge-90d');
select cron.schedule('relay-purge-90d', '17 3 * * *', $$
  delete from relay.messages where created_at < now() - interval '90 days';
  delete from relay.room_messages where at < now() - interval '90 days';
$$);
