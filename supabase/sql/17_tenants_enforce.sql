-- 17_tenants_enforce.sql：租戶隔離的資料庫底線（接在 16_tenants.sql 之後，確認回填無誤再跑）。
--   - tenant_id 一律 NOT NULL。
--   - messages 用複合外鍵 (tenant_id, from_node)／(tenant_id, to_node) 指向 nodes (tenant_id, id)：
--     就算函式有漏洞，資料庫也不允許信件的寄件人與收件人跨租戶。
--   - launches 同理；每個租戶最多一個現役角色節點（role='owner'）。
-- 執行方式：npx supabase db query --linked -f supabase/sql/17_tenants_enforce.sql（可重複執行）。
-- 現有資料若有 tenant_id 為空、或信件跨租戶，這支會直接報錯停下（交易整個回滾），不會留下半套限制。
-- 回退見 supabase/sql/rollback/16_tenants_down.sql（先拿掉這些限制）。

do $$
begin
  if exists (select 1 from relay.nodes where tenant_id is null) then
    raise exception '17_tenants_enforce: relay.nodes 還有 tenant_id 為空的資料，請先重跑 16_tenants.sql';
  end if;
  if exists (select 1 from relay.messages where tenant_id is null) then
    raise exception '17_tenants_enforce: relay.messages 還有 tenant_id 為空的資料';
  end if;
  if exists (select 1 from relay.invites where tenant_id is null) then
    raise exception '17_tenants_enforce: relay.invites 還有 tenant_id 為空的資料';
  end if;
  if exists (select 1 from relay.rooms where tenant_id is null) then
    raise exception '17_tenants_enforce: relay.rooms 還有 tenant_id 為空的資料';
  end if;
  if exists (select 1 from relay.launches where tenant_id is null) then
    raise exception '17_tenants_enforce: relay.launches 還有 tenant_id 為空的資料';
  end if;
  if exists (
    select 1 from relay.messages m
    join relay.nodes f on f.id = m.from_node join relay.nodes t on t.id = m.to_node
    where f.tenant_id <> t.tenant_id or m.tenant_id <> f.tenant_id
  ) then
    raise exception '17_tenants_enforce: 有跨租戶的信件，請先查清楚';
  end if;
  if exists (select 1 from relay.tenants where character_node is not null and not exists (
    select 1 from relay.nodes n where n.id = relay.tenants.character_node and n.tenant_id = relay.tenants.id)) then
    raise exception '17_tenants_enforce: 有租戶的角色節點不屬於該租戶';
  end if;
end $$;

alter table relay.nodes alter column tenant_id set not null;
alter table relay.messages alter column tenant_id set not null;
alter table relay.invites alter column tenant_id set not null;
alter table relay.rooms alter column tenant_id set not null;
alter table relay.launches alter column tenant_id set not null;

-- 複合外鍵需要被指向的欄位組合是唯一的（id 本來就是主鍵，這裡只是讓 (tenant_id, id) 也能被外鍵指向）
do $$ begin
  alter table relay.nodes add constraint nodes_tenant_id_id_key unique (tenant_id, id);
exception when duplicate_table or duplicate_object then null; end $$;

do $$ begin
  alter table relay.messages add constraint messages_from_same_tenant
    foreign key (tenant_id, from_node) references relay.nodes (tenant_id, id);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table relay.messages add constraint messages_to_same_tenant
    foreign key (tenant_id, to_node) references relay.nodes (tenant_id, id);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table relay.launches add constraint launches_requester_same_tenant
    foreign key (tenant_id, requested_by) references relay.nodes (tenant_id, id);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table relay.launches add constraint launches_node_same_tenant
    foreign key (tenant_id, node) references relay.nodes (tenant_id, id);
exception when duplicate_object then null; end $$;

-- 每個租戶恰好一個現役角色節點（owner）
create unique index if not exists nodes_one_owner_per_tenant
  on relay.nodes (tenant_id) where role = 'owner' and status = 'active';

-- 租戶的角色節點必須是自己租戶的節點
do $$ begin
  alter table relay.tenants add constraint tenants_character_node_fk
    foreign key (id, character_node) references relay.nodes (tenant_id, id) deferrable initially deferred;
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
