-- 回復檔（不是 migration，不會被部署；要用時人工執行）。
-- 回復 20261122100000_auth_observe.sql：取消清理排程，drop 兩個新函式與計數表。
-- 沒有動過任何既有函式；表內只有計數，沒有其他資料。回復後 Edge 的記錄呼叫會失敗，只寫 log、不影響回應。
begin;

select cron.unschedule('asn-auth-observe-purge-180d') where exists (select 1 from cron.job where jobname = 'asn-auth-observe-purge-180d');
drop function if exists public.asn_relay_auth_observe_purge(integer);
drop function if exists public.asn_relay_auth_observe(text, text, text, text);
drop table if exists relay.auth_observe;

commit;
