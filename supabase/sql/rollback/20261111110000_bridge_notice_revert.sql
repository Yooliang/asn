-- 回復 20261111110000_bridge_notice.sql：拿掉橋通知函式。橋收到 404 會自己退回舊的寄法（<節點>-收發室）；已寄出的通知與 kind 留著無害。
begin;
drop function if exists public.asn_relay_send_bridge_notice(text, uuid, text);
commit;
