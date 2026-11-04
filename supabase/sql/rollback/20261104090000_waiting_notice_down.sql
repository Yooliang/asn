-- 退回 20261104090000_waiting_notice.sql：拿掉通知函式。已寄出的信不受影響。
begin;
drop function if exists public.asn_relay_waiting_notice(text);
commit;
