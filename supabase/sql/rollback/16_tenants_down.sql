-- 16_tenants_down.sql：退回多使用者第一期 A 段（16_tenants.sql／17_tenants_enforce.sql）的資料庫部分。
-- 前提：已先把 irori-api、irori-relay 切回舊版本（走 HTTP＋IRORI_RELAY_KEY、authenticate 用 IRORI_OWNER_EMAILS）。
-- 安全：只拿掉限制與新函式，不刪任何資料表、欄位與資料（tenant_id 欄位、relay.tenants、irori.accounts 都留著，不礙事；要再上線重跑 16、17 即可）。
-- 執行方式（依序，每支都可重複執行）：
--   1. npx supabase db query --linked -f supabase/sql/rollback/16_tenants_down.sql
--   2. 重跑舊版函式定義，還原舊的函式本體：01_relay.sql、02_members.sql、05_rooms.sql、07_launch.sql
--      （都是 create or replace／drop+create，可重複執行；04、08、09 沒被 16 改過，不用跑）
-- 注意：如果已經有第二個租戶以上的使用者，退回後他們的節點會出現在租戶 1 的名單（舊函式不分租戶）——
-- 退回前請先停用那些帳號（irori_account_set_status），或確認還沒有人加入。

-- 1. 拿掉 17 的限制
alter table relay.tenants drop constraint if exists tenants_character_node_fk;
drop index if exists relay.nodes_one_owner_per_tenant;
alter table relay.launches drop constraint if exists launches_node_same_tenant;
alter table relay.launches drop constraint if exists launches_requester_same_tenant;
alter table relay.messages drop constraint if exists messages_to_same_tenant;
alter table relay.messages drop constraint if exists messages_from_same_tenant;
alter table relay.nodes drop constraint if exists nodes_tenant_id_id_key;
alter table relay.nodes alter column tenant_id drop not null;
alter table relay.messages alter column tenant_id drop not null;
alter table relay.invites alter column tenant_id drop not null;
alter table relay.rooms alter column tenant_id drop not null;
alter table relay.launches alter column tenant_id drop not null;

-- 2. 拿掉 16 新增的函式（舊函式本體靠重跑 01／02／05／07 還原，見上）
drop function if exists public.irori_tenant_claim_legacy(text);
drop function if exists public.irori_tenant_provision(uuid, text);
drop function if exists public.irori_tenant_of_user(uuid);
drop function if exists public.irori_relay_whoami(uuid);
drop function if exists public.irori_tenant_set_owner_name(uuid, text);
drop function if exists public.irori_account_resolve(uuid, text, text, boolean, numeric);
drop function if exists public.irori_account_invite_create(uuid, text, text, text, text, integer);
drop function if exists public.irori_account_invite_revoke(uuid);
drop function if exists public.irori_account_redeem(uuid, text, text, text, numeric);
drop function if exists public.irori_account_set_status(text, text);
drop function if exists public.irori_account_list();
drop function if exists public.irori_relay_list(uuid);
drop function if exists public.irori_relay_list_by_node(text);
drop function if exists public.irori_relay_room_auto_rules(text);
drop function if exists relay.account_view(text);
drop function if exists relay.node_tenant(text);
drop function if exists relay.room_in_tenant(text, text);
drop function if exists relay.room_key_ok(text, uuid);
drop function if exists relay.room_member_name(text, uuid);

-- 3. 舊的 irori_relay_auth 回傳欄位少一個 tenant_id：先丟掉，等 01_relay.sql 重新建立
drop function if exists public.irori_relay_auth(text);

-- 想把資料也清乾淨（不建議；留著不礙事）：
--   drop table if exists irori.account_invites, irori.accounts;
--   alter table relay.nodes drop column tenant_id; …（messages／invites／rooms／launches 同）
--   drop table if exists relay.tenants; drop sequence if exists relay.tenant_serial;

notify pgrst, 'reload schema';
