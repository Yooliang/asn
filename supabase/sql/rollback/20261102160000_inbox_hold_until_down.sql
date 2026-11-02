-- 退回 20261102160000_inbox_hold_until.sql：只拿掉設定函式，欄位 relay.nodes.inbox_hold_until 刻意保留——
-- #648 的 asn_relay_inbox_watch 也讀這個欄位，丟掉欄位會讓它壞掉；欄位只是可空的提示時間，留著無害。
begin;
drop function if exists public.asn_relay_set_inbox_hold(text, timestamptz, integer, boolean);
commit;
