-- 手機換一把新的節點金鑰（0.2.17）：伺服器端。
-- 一、relay.nodes 多四欄：prev_key_hash／prev_key_until（換鑰後舊金鑰的寬限，10 分鐘）、key_rotated_at、rotation_id（冪等用）。
-- 二、relay.node_key_rotations：換鑰紀錄（限流用：每個節點滾動 24 小時最多 3 次成功；超過 7 天的在函式裡順手清掉）。
-- 三、asn_relay_node_rotate_key(p_node, p_new_hash, p_rotation_id)：用舊金鑰認證後的節點，換上新金鑰的雜湊。只給 service_role。
--     同一個 rotation_id＋同一個新雜湊重送＝回 ok（手機中途斷線重試用）；新雜湊不可等於現用或寬限中的舊雜湊。
-- 四、asn_relay_auth：金鑰雜湊對得上現用的、或對得上寬限中的舊的（prev_key_until 還沒到）都算過；
--     第一次用新金鑰成功就把舊的清掉（舊金鑰從此失效）。回傳欄位與上一版相同。
-- 回復：supabase/sql/rollback/20261113300000_node_key_rotate_down.sql
begin;

alter table relay.nodes
  add column if not exists prev_key_hash text,
  add column if not exists prev_key_until timestamptz,
  add column if not exists key_rotated_at timestamptz,
  add column if not exists rotation_id uuid;

create table if not exists relay.node_key_rotations (
  node text not null,
  at timestamptz not null default now(),
  constraint node_key_rotations_node_fkey foreign key (node) references relay.nodes(id) on delete cascade
);
create index if not exists node_key_rotations_node_at_idx on relay.node_key_rotations (node, at);
alter table relay.node_key_rotations enable row level security;
revoke all on relay.node_key_rotations from public, anon, authenticated;

create or replace function public.asn_relay_node_rotate_key(p_node text, p_new_hash text, p_rotation_id uuid)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_key text;
  v_prev text;
  v_rot uuid;
  v_n int;
begin
  if p_node is null or p_rotation_id is null or p_new_hash is null or p_new_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select n.key_hash, n.prev_key_hash, n.rotation_id into v_key, v_prev, v_rot
    from relay.nodes n where n.id = p_node and n.status = 'active' for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  -- 冪等：同一次換鑰重送
  if v_rot = p_rotation_id and v_key = p_new_hash then
    return jsonb_build_object('ok', true);
  end if;
  if p_new_hash = v_key or p_new_hash = v_prev then
    return jsonb_build_object('error', 'bad_request');
  end if;
  delete from relay.node_key_rotations where at < now() - interval '7 days';
  select count(*) into v_n from relay.node_key_rotations where node = p_node and at > now() - interval '24 hours';
  if v_n >= 3 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  update relay.nodes
     set prev_key_hash = v_key, prev_key_until = now() + interval '10 minutes',
         key_hash = p_new_hash, rotation_id = p_rotation_id, key_rotated_at = now()
   where id = p_node;
  insert into relay.node_key_rotations (node) values (p_node);
  return jsonb_build_object('ok', true);
exception when unique_violation then
  return jsonb_build_object('error', 'bad_request');
end;
$function$;

revoke all on function public.asn_relay_node_rotate_key(text, text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_node_rotate_key(text, text, uuid) to service_role;

-- 金鑰 → 節點。除了現用的雜湊，也認寬限中的舊雜湊；用新金鑰成功一次就清掉舊的。租戶被停用的節點金鑰暫時失效（同上一版）
create or replace function public.asn_relay_auth(p_key_hash text)
 returns TABLE(id text, bell_topic text, role text, can_invite boolean, tenant_id uuid)
 language sql security definer set search_path to ''
as $function$
  update relay.nodes n set last_seen_at = now(),
      prev_key_hash = case when n.key_hash = p_key_hash then null else n.prev_key_hash end,
      prev_key_until = case when n.key_hash = p_key_hash then null else n.prev_key_until end
    where (n.key_hash = p_key_hash or (n.prev_key_hash = p_key_hash and n.prev_key_until > now())) and n.status = 'active'
      and (n.tenant_id is null or exists (select 1 from relay.tenants t where t.id = n.tenant_id and t.status = 'active'))
    returning n.id, n.bell_topic, n.role, n.can_invite, n.tenant_id;
$function$;

commit;
