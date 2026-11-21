-- 觀測計數表的「通過方式」多接受一個值 blocked（#500 拆項 3b：旗標擋下時也記一筆）。
-- 只改 relay.auth_observe.via 的檢查條件：原本 signed／role，放寬成 signed／role／blocked；其他值照樣拒絕。
-- 不改資料表欄位、不改任何函式（寫入函式本身沒有驗證值，值由資料表的檢查條件把關）、不改權限。
-- 部署順序：本 migration → relay Edge（開始記 blocked）。舊 Edge 不會寫 blocked，提早套不會壞；Edge 先於 migration 時，記 blocked 失敗只寫 log、不影響回應。
-- 回復：supabase/sql/rollback/20261122120000_auth_observe_blocked_down.sql（先刪掉 blocked 的列，再還原原本的檢查條件）。
begin;

alter table relay.auth_observe drop constraint auth_observe_via_check;
alter table relay.auth_observe add constraint auth_observe_via_check check (via in ('signed', 'role', 'blocked'));

commit;
