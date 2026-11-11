-- 回復 20261113300000_node_key_rotate.sql：asn_relay_auth 還原成只認現用雜湊的版本，移除換鑰函式、紀錄表與四個欄位。
-- 已經換過鑰的手機照舊用新金鑰（現用雜湊已是新的，不受影響）；寬限中的舊金鑰會立刻失效。
begin;

create or replace function public.asn_relay_auth(p_key_hash text)
 returns TABLE(id text, bell_topic text, role text, can_invite boolean, tenant_id uuid)
 language sql security definer set search_path to ''
as $function$
  update relay.nodes n set last_seen_at = now()
    where n.key_hash = p_key_hash and n.status = 'active'
      and (n.tenant_id is null or exists (select 1 from relay.tenants t where t.id = n.tenant_id and t.status = 'active'))
    returning n.id, n.bell_topic, n.role, n.can_invite, n.tenant_id;
$function$;

drop function if exists public.asn_relay_node_rotate_key(text, text, uuid);
drop table if exists relay.node_key_rotations;
alter table relay.nodes
  drop column if exists prev_key_hash,
  drop column if exists prev_key_until,
  drop column if exists key_rotated_at,
  drop column if exists rotation_id;

commit;
