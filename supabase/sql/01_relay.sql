-- Relay backend (idempotent). The relay schema is NOT exposed to PostgREST;
-- access goes only through public.irori_relay_* SECURITY DEFINER functions, granted to service_role only.

create schema if not exists relay;
revoke all on schema relay from public, anon, authenticated;

create table if not exists relay.nodes (
  id text primary key,
  name text not null,
  key_hash text not null unique,
  bell_topic text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists relay.messages (
  id uuid primary key default gen_random_uuid(),
  from_node text not null references relay.nodes(id),
  from_agent text,
  to_node text not null references relay.nodes(id),
  to_agent text,
  body text not null check (char_length(body) between 1 and 20000),
  reply_to uuid references relay.messages(id),
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  acked_at timestamptz
);

alter table relay.nodes add column if not exists kind text;
alter table relay.nodes add column if not exists status text not null default 'active';
alter table relay.nodes add column if not exists last_seen_at timestamptz;
alter table relay.nodes add column if not exists note text;
alter table relay.nodes add column if not exists role text not null default 'member';
alter table relay.nodes add column if not exists machine text;
alter table relay.nodes add column if not exists can_invite boolean not null default false;

create index if not exists messages_inbox_idx
  on relay.messages (to_node, created_at) where acked_at is null;
create index if not exists messages_rate_idx
  on relay.messages (from_node, created_at);

alter table relay.nodes enable row level security;
alter table relay.messages enable row level security;
revoke all on all tables in schema relay from public, anon, authenticated;

-- Look up an active node by key hash (left nodes count as not found); stamps last_seen_at (heartbeat).
drop function if exists public.irori_relay_auth(text);
create function public.irori_relay_auth(p_key_hash text)
returns table(id text, bell_topic text, role text, can_invite boolean)
language sql security definer set search_path = ''
as $$
  update relay.nodes n set last_seen_at = now()
    where n.key_hash = p_key_hash and n.status = 'active'
    returning n.id, n.bell_topic, n.role, n.can_invite;
$$;

-- Send: sender node comes from the caller (Edge Function, after key check). 30 per minute per node.
create or replace function public.irori_relay_send(
  p_from_node text, p_from_agent text, p_to_node text, p_to_agent text,
  p_body text, p_reply_to uuid
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_topic text;
  v_id uuid;
  v_recent int;
begin
  if p_body is null or char_length(p_body) < 1 or char_length(p_body) > 20000 then
    return jsonb_build_object('error', 'bad_body');
  end if;
  select bell_topic into v_topic from relay.nodes where id = p_to_node and status = 'active';
  if v_topic is null then
    return jsonb_build_object('error', 'unknown_to_node');
  end if;
  select count(*) into v_recent from relay.messages
    where from_node = p_from_node and created_at > now() - interval '1 minute';
  if v_recent >= 30 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  if p_reply_to is not null and not exists (select 1 from relay.messages where id = p_reply_to) then
    p_reply_to := null;
  end if;
  insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to)
    values (p_from_node, p_from_agent, p_to_node, p_to_agent, p_body, p_reply_to)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$$;

-- Inbox: unacked, oldest first, max 50; stamps delivered_at.
create or replace function public.irori_relay_inbox(p_node text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_ids uuid[];
  v_out jsonb;
begin
  select coalesce(array_agg(s.id), array[]::uuid[]) into v_ids from (
    select m.id from relay.messages m
    where m.to_node = p_node and m.acked_at is null
    order by m.created_at, m.id limit 50
  ) s;
  update relay.messages set delivered_at = now()
    where id = any(v_ids) and delivered_at is null;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'from_node', m.from_node, 'from_agent', m.from_agent,
      'to_node', m.to_node, 'to_agent', m.to_agent, 'body', m.body,
      'reply_to', m.reply_to, 'created_at', m.created_at,
      'trust', case when f.role = 'owner' then 'owner' else 'member' end) order by m.created_at, m.id), '[]'::jsonb)
    into v_out from relay.messages m join relay.nodes f on f.id = m.from_node where m.id = any(v_ids);
  return v_out;
end;
$$;

-- Ack: only mail addressed to the caller's own node.
create or replace function public.irori_relay_ack(p_node text, p_ids uuid[])
returns int
language plpgsql security definer set search_path = ''
as $$
declare v_n int;
begin
  update relay.messages set acked_at = now()
    where to_node = p_node and id = any(p_ids) and acked_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.irori_relay_auth(text)',
    'public.irori_relay_send(text,text,text,text,text,uuid)',
    'public.irori_relay_inbox(text)',
    'public.irori_relay_ack(text,uuid[])'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
