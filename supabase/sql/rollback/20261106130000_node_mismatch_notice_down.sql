-- 退回 20261106130000_node_mismatch_notice.sql：拿掉通知函式。已寄出的信不受影響。
begin;
drop function if exists public.asn_relay_node_mismatch_notice(text, text);
commit;
