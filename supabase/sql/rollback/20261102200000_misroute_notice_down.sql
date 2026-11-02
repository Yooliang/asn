-- 退回 20261102200000_misroute_notice.sql：拿掉通知函式。已寄出的信不受影響。
begin;
drop function if exists public.asn_relay_misroute_notice(text, uuid);
commit;
