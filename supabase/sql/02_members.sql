-- Relay members: invites, register, leave, list (idempotent; run after 01_relay.sql).

create table if not exists relay.invites (
  code_hash text primary key,
  for_id text not null,
  for_name text not null,
  created_by text not null references relay.nodes(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '5 minutes',
  used_at timestamptz
);

create table if not exists relay.register_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  at timestamptz not null default now()
);
create index if not exists register_attempts_idx on relay.register_attempts (ip_hash, at);

alter table relay.invites enable row level security;
alter table relay.register_attempts enable row level security;
revoke all on all tables in schema relay from public, anon, authenticated;

-- Owner opens a one-time invite bound to for_id (code hash supplied by the Edge Function).
create or replace function public.irori_relay_invite(
  p_node text, p_code_hash text, p_for_id text, p_for_name text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_exp timestamptz;
  v_me relay.nodes%rowtype;
begin
  -- owner: anyone; can_invite member: only ids under own machine prefix (own id up to and including the first '-')
  select * into v_me from relay.nodes where id = p_node and status = 'active';
  if not found or not (
    v_me.role = 'owner'
    or (v_me.can_invite and left(p_for_id, char_length(split_part(v_me.id, '-', 1) || '-')) = split_part(v_me.id, '-', 1) || '-')
  ) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_for_id !~ '^[A-Za-z0-9_-]{1,32}$' or p_for_name is null or char_length(p_for_name) not between 1 and 100 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if exists (select 1 from relay.nodes where id = p_for_id and status = 'active') then
    return jsonb_build_object('error', 'id_taken');
  end if;
  delete from relay.invites where expires_at < now() - interval '1 day';
  insert into relay.invites (code_hash, for_id, for_name, created_by)
    values (p_code_hash, p_for_id, p_for_name, p_node)
    returning expires_at into v_exp;
  return jsonb_build_object('expires_at', v_exp);
end;
$$;

-- Register with an invite: one-time, bound id, 5 minutes; 10 attempts per IP per hour. Role is always member.
create or replace function public.irori_relay_register(
  p_ip_hash text, p_code_hash text, p_id text, p_name text, p_kind text,
  p_machine text, p_note text, p_key_hash text, p_bell_topic text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_inv relay.invites%rowtype;
  v_n int;
begin
  delete from relay.register_attempts where at < now() - interval '1 day';
  select count(*) into v_n from relay.register_attempts
    where ip_hash = p_ip_hash and at > now() - interval '1 hour';
  if v_n >= 10 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.register_attempts (ip_hash) values (p_ip_hash);

  select * into v_inv from relay.invites where code_hash = p_code_hash for update;
  if not found or v_inv.used_at is not null or v_inv.expires_at < now() or v_inv.for_id <> p_id then
    return jsonb_build_object('error', 'invalid_invite');
  end if;
  if p_name is null or char_length(p_name) not between 1 and 100
     or p_machine is null or char_length(p_machine) not between 1 and 40 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if exists (select 1 from relay.nodes where id = p_id and status = 'active') then
    return jsonb_build_object('error', 'id_taken');
  end if;
  if p_kind is null or p_kind not in ('claude', 'gpt', 'gemini', 'grok', 'other') then
    p_kind := 'other';
  end if;

  insert into relay.nodes (id, name, key_hash, bell_topic, kind, role, can_invite, machine, note, status, last_seen_at)
    values (p_id, p_name, p_key_hash, p_bell_topic, p_kind, 'member', false, p_machine, left(p_note, 500), 'active', now())
    on conflict (id) do update set
      name = excluded.name, key_hash = excluded.key_hash, bell_topic = excluded.bell_topic,
      kind = excluded.kind, role = 'member', can_invite = false, machine = excluded.machine, note = excluded.note,
      status = 'active', last_seen_at = now();
  update relay.invites set used_at = now() where code_hash = p_code_hash;
  return jsonb_build_object('id', p_id, 'bell_topic', p_bell_topic);
end;
$$;

-- Owner edits any member's machine / display name.
create or replace function public.irori_relay_update(p_node text, p_id text, p_machine text, p_name text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from relay.nodes where id = p_node and role = 'owner' and status = 'active') then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if (p_machine is not null and char_length(p_machine) not between 1 and 40)
     or (p_name is not null and char_length(p_name) not between 1 and 100)
     or (p_machine is null and p_name is null) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.nodes set machine = coalesce(p_machine, machine), name = coalesce(p_name, name)
    where id = p_id and status = 'active';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- Leave: status left and the key stops working.
create or replace function public.irori_relay_leave(p_node text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update relay.nodes set status = 'left', key_hash = 'revoked:' || gen_random_uuid()::text
    where id = p_node and status = 'active';
  return found;
end;
$$;

-- List active members. presence: live＝3 分鐘內有呼叫（有掛收信程式，心跳 2 分鐘）、recent＝24 小時內、idle＝更久或從沒有；online＝live（相容舊版）
create or replace function public.irori_relay_list()
returns jsonb
language sql security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id, 'name', n.name, 'kind', n.kind, 'machine', n.machine,
    'online', coalesce(n.last_seen_at > now() - interval '3 minutes', false),
    'presence', case when n.last_seen_at > now() - interval '3 minutes' then 'live'
                     when n.last_seen_at > now() - interval '24 hours' then 'recent' else 'idle' end,
    'last_seen_at', n.last_seen_at) order by n.id), '[]'::jsonb)
  from relay.nodes n where n.status = 'active';
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.irori_relay_invite(text,text,text,text)',
    'public.irori_relay_register(text,text,text,text,text,text,text,text,text)',
    'public.irori_relay_leave(text)',
    'public.irori_relay_update(text,text,text,text)',
    'public.irori_relay_list()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
