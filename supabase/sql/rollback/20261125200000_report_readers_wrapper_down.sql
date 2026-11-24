-- 退回 20261125200000_report_readers_wrapper.sql：只 drop 那一支包裝函式（2a 的函式與資料都不動）。
begin;
drop function if exists public.asn_relay_report_readers(text, text);
commit;
