-- 回復檔（不是 migration，不會被部署；要用時人工執行）。
-- 回復 20261122120000_auth_observe_blocked.sql：先刪掉 via = 'blocked' 的列（沒有別的辦法能保留它們：原本的條件不接受這個值，
-- 硬轉成 signed／role 會把「被擋下」的次數混進「通過」的統計，所以直接刪，這些只是計數），再把檢查條件逐字還原成 20261122100000_auth_observe.sql 的樣子。
-- 回復後 Edge 記 blocked 會被資料表拒絕，只寫 log、不影響回應。
begin;

delete from relay.auth_observe where via = 'blocked';
alter table relay.auth_observe drop constraint auth_observe_via_check;
alter table relay.auth_observe add constraint auth_observe_via_check check (via in ('signed', 'role'));

commit;
