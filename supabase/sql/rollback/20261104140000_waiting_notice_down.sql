-- 退回 20261104140000_waiting_notice.sql：拿掉通知函式。已寄出的信不受影響。
begin;
drop function if exists public.asn_relay_waiting_notice(text, text, text, text);
commit;
