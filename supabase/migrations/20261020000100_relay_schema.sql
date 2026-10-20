-- 收發室資料表（asn 專案）：依 2026-10-20 舊後台（Irori 專案）relay schema 的實際結構整理。
-- 不帶 Irori 專用的東西（irori schema、irori.kv、irori.accounts）。
-- 所有資料表只給後端（service role／security definer 函式）用，不暴露給 PostgREST：
-- 啟用 RLS 且不建任何 policy，並收回 anon／authenticated 的一切權限。

create schema if not exists relay;

create sequence relay.tenant_serial;

create table relay.tenants (
  id uuid not null default gen_random_uuid(),
  serial integer not null default nextval('relay.tenant_serial'::regclass),
  owner_user uuid,
  character_node text,
  id_prefix text,
  owner_name text not null default '朋友',
  status text not null default 'active',
  features jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint tenants_pkey primary key (id),
  constraint tenants_owner_user_key unique (owner_user),
  constraint tenants_serial_key unique (serial),
  constraint tenants_status_check check (status = any (array['active','suspended','deleting']))
);

create table relay.nodes (
  id text not null,
  name text not null,
  key_hash text not null,
  bell_topic text not null,
  created_at timestamptz not null default now(),
  kind text,
  status text not null default 'active',
  last_seen_at timestamptz,
  note text,
  role text not null default 'member',
  machine text,
  can_invite boolean not null default false,
  can_roster boolean not null default true,
  launcher jsonb,
  launcher_at timestamptz,
  tenant_id uuid not null,
  avatar text,
  avatar_updated_at timestamptz,
  constraint nodes_pkey primary key (id),
  constraint nodes_bell_topic_key unique (bell_topic),
  constraint nodes_key_hash_key unique (key_hash),
  constraint nodes_tenant_id_id_key unique (tenant_id, id),
  constraint nodes_tenant_id_fkey foreign key (tenant_id) references relay.tenants(id),
  constraint nodes_avatar_check check (avatar is null or (char_length(avatar) <= 48000
    and avatar ~ '^data:image/(png|webp);base64,[A-Za-z0-9+/]+={0,2}$'))
);
create index nodes_tenant_idx on relay.nodes (tenant_id);
create unique index nodes_one_owner_per_tenant on relay.nodes (tenant_id) where role = 'owner' and status = 'active';

-- 租戶的「角色節點」：延後檢查，才能先建租戶再建節點
alter table relay.tenants add constraint tenants_character_node_fk
  foreign key (id, character_node) references relay.nodes (tenant_id, id) deferrable initially deferred;

create table relay.invites (
  code_hash text not null,
  prefix text,
  note text,
  reissue_for text,
  created_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '00:15:00'),
  used_at timestamptz,
  for_id text,
  for_name text,
  tenant_id uuid not null,
  constraint invites_pkey primary key (code_hash),
  constraint invites_created_by_fkey foreign key (created_by) references relay.nodes(id),
  constraint invites_tenant_id_fkey foreign key (tenant_id) references relay.tenants(id)
);

create table relay.register_attempts (
  id bigint generated always as identity,
  ip_hash text not null,
  at timestamptz not null default now(),
  constraint register_attempts_pkey primary key (id)
);
create index register_attempts_idx on relay.register_attempts (ip_hash, at);

create table relay.launches (
  id uuid not null default gen_random_uuid(),
  requested_by text not null,
  node text not null,
  profile text not null,
  name text not null,
  cwd text not null,
  first_message text,
  status text not null default 'pending',
  detail text,
  created_at timestamptz not null default now(),
  taken_at timestamptz,
  done_at timestamptz,
  tenant_id uuid not null,
  constraint launches_pkey primary key (id),
  constraint launches_first_message_check check (first_message is null or (char_length(first_message) >= 1 and char_length(first_message) <= 4000)),
  constraint launches_status_check check (status = any (array['pending','taken','ok','failed','unconfirmed'])),
  constraint launches_node_fkey foreign key (node) references relay.nodes(id),
  constraint launches_node_same_tenant foreign key (tenant_id, node) references relay.nodes(tenant_id, id),
  constraint launches_requested_by_fkey foreign key (requested_by) references relay.nodes(id),
  constraint launches_requester_same_tenant foreign key (tenant_id, requested_by) references relay.nodes(tenant_id, id),
  constraint launches_tenant_id_fkey foreign key (tenant_id) references relay.tenants(id)
);
create index launches_node_idx on relay.launches (node, created_at);
create index launches_tenant_idx on relay.launches (tenant_id);

create table relay.messages (
  id uuid not null default gen_random_uuid(),
  from_node text not null,
  from_agent text,
  to_node text not null,
  to_agent text,
  body text not null,
  reply_to uuid,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  acked_at timestamptz,
  tenant_id uuid not null,
  expects_reply boolean,
  constraint messages_pkey primary key (id),
  constraint messages_body_check check (char_length(body) >= 1 and char_length(body) <= 20000),
  constraint messages_from_node_fkey foreign key (from_node) references relay.nodes(id),
  constraint messages_from_same_tenant foreign key (tenant_id, from_node) references relay.nodes(tenant_id, id),
  constraint messages_reply_to_fkey foreign key (reply_to) references relay.messages(id),
  constraint messages_tenant_id_fkey foreign key (tenant_id) references relay.tenants(id),
  constraint messages_to_node_fkey foreign key (to_node) references relay.nodes(id),
  constraint messages_to_same_tenant foreign key (tenant_id, to_node) references relay.nodes(tenant_id, id)
);
create index messages_inbox_idx on relay.messages (to_node, created_at) where acked_at is null;
create index messages_rate_idx on relay.messages (from_node, created_at);

create table relay.roster (
  node text not null,
  name text not null,
  status text,
  cwd_label text,
  seen_at timestamptz not null default now(),
  engine text,
  constraint roster_pkey primary key (node, name),
  constraint roster_node_fkey foreign key (node) references relay.nodes(id)
);

create table relay.rooms (
  id text not null,
  name text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  last_seq bigint not null default 0,
  auto_prefixes text[] not null default '{}'::text[],
  tenant_id uuid not null,
  constraint rooms_pkey primary key (id),
  constraint rooms_id_check check (id ~ '^[A-Za-z0-9_-]{1,32}$'),
  constraint rooms_name_check check (char_length(name) >= 1 and char_length(name) <= 60),
  constraint rooms_tenant_id_fkey foreign key (tenant_id) references relay.tenants(id)
);
create index rooms_tenant_idx on relay.rooms (tenant_id);

create table relay.room_members (
  room_id text not null,
  member text not null,
  role text not null default 'member',
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  read_seq bigint not null default 0,
  joined_via text not null default 'manual',
  constraint room_members_pkey primary key (room_id, member),
  constraint room_members_joined_via_check check (joined_via = any (array['auto','manual'])),
  constraint room_members_member_check check (char_length(member) >= 1 and char_length(member) <= 120),
  constraint room_members_role_check check (role = any (array['owner','member'])),
  constraint room_members_room_id_fkey foreign key (room_id) references relay.rooms(id)
);

create table relay.room_messages (
  room_id text not null,
  seq bigint not null,
  from_member text not null,
  trust text not null,
  body text not null,
  mentions text[] not null default '{}'::text[],
  at timestamptz not null default now(),
  constraint room_messages_pkey primary key (room_id, seq),
  constraint room_messages_body_check check (char_length(body) >= 1 and char_length(body) <= 20000),
  constraint room_messages_trust_check check (trust = any (array['owner','member'])),
  constraint room_messages_room_id_fkey foreign key (room_id) references relay.rooms(id)
);
create index room_messages_rate_idx on relay.room_messages (room_id, from_member, at);

create table relay.room_pins (
  room_id text not null,
  body text not null default '',
  updated_by text,
  updated_at timestamptz not null default now(),
  version integer not null default 0,
  constraint room_pins_pkey primary key (room_id),
  constraint room_pins_body_check check (char_length(body) <= 20000),
  constraint room_pins_room_id_fkey foreign key (room_id) references relay.rooms(id)
);

-- 一律啟用 RLS（不建 policy）並收回前端角色權限：資料表不暴露給 PostgREST
alter table relay.tenants enable row level security;
alter table relay.nodes enable row level security;
alter table relay.invites enable row level security;
alter table relay.register_attempts enable row level security;
alter table relay.launches enable row level security;
alter table relay.messages enable row level security;
alter table relay.roster enable row level security;
alter table relay.rooms enable row level security;
alter table relay.room_members enable row level security;
alter table relay.room_messages enable row level security;
alter table relay.room_pins enable row level security;

revoke all on schema relay from public, anon, authenticated;
revoke all on all tables in schema relay from public, anon, authenticated;
revoke all on all sequences in schema relay from public, anon, authenticated;
