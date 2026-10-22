-- 退回 20261022050000_cloud_agent_invite：拿掉三個雲端代理函式。
-- 已建立的雲端代理節點不會被刪除；created_via = 'cloud-invite' 的列要先改成 null 才能放回舊的檢查條件。
begin;
drop function if exists public.asn_cloud_node_revoke(uuid, text);
drop function if exists public.asn_cloud_node_list(uuid);
drop function if exists public.asn_cloud_node_create(uuid, text, text, text);
update relay.nodes set created_via = null where created_via = 'cloud-invite';
alter table relay.nodes drop constraint if exists nodes_created_via_check;
alter table relay.nodes add constraint nodes_created_via_check
  check (created_via is null or created_via in ('login-device', 'claim-existing'));
commit;
