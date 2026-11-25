-- 退回 20261125320000_fp_show_requests.sql：拿掉請電腦顯示指紋的六支函式與 relay.fp_show_requests。舊版用戶端不呼叫它們，拿掉不影響任何既有功能。
begin;

drop function if exists public.asn_relay_fp_show_end(text, uuid, uuid);
drop function if exists public.asn_relay_fp_show_status(text, uuid, uuid);
drop function if exists public.asn_relay_fp_show_ack(text, uuid, text, text);
drop function if exists public.asn_relay_fp_show_take(text);
drop function if exists public.asn_relay_fp_show_request(text, uuid, text);
drop function if exists public.asn_relay_fp_show_expire();
drop table if exists relay.fp_show_requests;

commit;
