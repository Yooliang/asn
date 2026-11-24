-- 退回 20261125100000_report_bus.sql：drop 全部新函式與兩張表（函式先拿掉，再 drop reports、report_kinds）。
-- 注意：reports 的資料會一起消失（本段只有測試用的 echo，沒有正式資料）。
begin;
drop function if exists public.asn_relay_report_get(text, text, text[]);
drop function if exists public.asn_relay_report(text, text, jsonb);
drop function if exists relay.report_readers(text, text);
drop function if exists relay.report_can_read(text, text, text);
drop function if exists relay.report_validate(text, jsonb);
drop function if exists relay.report_check_spec(jsonb, jsonb);
drop function if exists relay.report_check_value(jsonb, jsonb, text[], text, int);
drop table if exists relay.reports;
drop table if exists relay.report_kinds;
commit;
