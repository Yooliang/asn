-- 20261111120000_send_client_id.sql 的回復檔（不是 migration，不會被部署；要用時人工執行）。
-- 既有的寄信函式（asn_relay_send／_core／_voice）本來就沒被改，不需要換回；只移除新增的兩支函式、索引與欄位。
-- 回復後 Edge 找不到 asn_relay_send_idem 會自動退回一般寄信（不去重、信照寄）。
begin;
drop function if exists public.asn_relay_send_lookup(text, uuid);
drop function if exists public.asn_relay_send_idem(uuid, text, text, text, text, text, uuid, boolean, uuid, boolean, boolean);
drop index if exists relay.relay_messages_from_client_uidx;
alter table relay.messages drop column if exists client_id;
commit;
