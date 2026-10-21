-- 退回 20261021030000_account_login：拿掉帳號函式、稽核表與兩個欄位。
-- 先把 relay 函式退回沒有 account_bootstrap／node_claim／node_create 動作的版本（否則這三個動作只會回 500，不影響其他動作）。
-- 已建立的登入帳號租戶與其節點不會被刪除（節點的 owner_user 欄位本來就存在）。
begin;
drop function if exists public.asn_admin_adopt_tenant(text, integer);
drop function if exists public.asn_node_create(uuid, text, text, text, text, text);
drop function if exists public.asn_node_claim(uuid, text);
drop function if exists public.asn_account_bootstrap(uuid, text, text);
drop function if exists relay.asn_account_nodes(uuid);
drop function if exists relay.asn_ensure_tenant(uuid, text);
drop table if exists relay.account_events;
drop index if exists relay.nodes_owner_device_key;
alter table relay.nodes drop constraint if exists nodes_created_via_check;
alter table relay.nodes drop constraint if exists nodes_device_id_check;
alter table relay.nodes drop column if exists created_via;
alter table relay.nodes drop column if exists device_id;
commit;
