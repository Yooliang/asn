-- 退回 20261029100000_acct_roster.sql：拿掉帳號列表的兩支 RPC、四支小工具與 relay.asn_user_accounts。
-- 注意：drop table 會刪掉表裡的資料（從各台回報算出來的帳號與額度窗，可由之後的回報重建，但仍算刪資料），執行前先在群組問。
-- 舊的 asn_relay_acct_report、asn_relay_acct_quota、relay.asn_accounts 沒被 up 檔動過，這裡也不動。
-- 先把 relay 換回前一版（不呼叫 asn_relay_acct_roster_report／asn_relay_acct_roster）再跑；沒換也不會壞，只是 relay 會記 log、acct_roster 回 500。
begin;

drop function if exists public.asn_relay_acct_roster(text, uuid);
drop function if exists public.asn_relay_acct_roster_report(text, jsonb);
drop function if exists public.asn_relay_acct_legacy_windows(jsonb, text);
drop function if exists public.asn_relay_acct_windows_clean(text, jsonb, text, timestamptz);
drop function if exists public.asn_relay_acct_iso(jsonb);
drop function if exists public.asn_relay_acct_window_judge(text, text, jsonb, jsonb, timestamptz);
drop table if exists relay.asn_user_accounts;

commit;
