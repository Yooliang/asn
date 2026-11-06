-- 退回 20261106120000_cloud_node_rename.sql：拿掉改名函式。已改過的名字與 account_events 紀錄保留，不還原。
begin;
drop function if exists public.asn_cloud_node_rename(uuid, text, text);
commit;
