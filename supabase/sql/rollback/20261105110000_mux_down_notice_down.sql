-- 退回 20261105110000_mux_down_notice.sql：拿掉通知函式。已寄出的信不受影響。
begin;
drop function if exists public.asn_relay_mux_down_notice(text, integer, boolean);
commit;
