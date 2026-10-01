-- Relay members: invites, register, leave, list (idempotent; run after 01_relay.sql).

create table if not exists relay.invites (
  code_hash text primary key,
  prefix text,                 -- null = any id (owner); else the id must start with it
  note text,
  reissue_for text,            -- set = key-reset code for this existing member (not a normal invite)
  created_by text not null references relay.nodes(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  used_at timestamptz
);
-- upgrade path from the earlier shape (invite bound to for_id / for_name)
alter table relay.invites add column if not exists prefix text;
alter table relay.invites add column if not exists note text;
alter table relay.invites add column if not exists reissue_for text;
alter table relay.invites add column if not exists for_id text;
alter table relay.invites add column if not exists for_name text;
alter table relay.invites alter column for_id drop not null;
alter table relay.invites alter column for_name drop not null;
alter table relay.invites alter column expires_at set default now() + interval '15 minutes';

create table if not exists relay.register_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  at timestamptz not null default now()
);
create index if not exists register_attempts_idx on relay.register_attempts (ip_hash, at);

alter table relay.invites enable row level security;
alter table relay.register_attempts enable row level security;
revoke all on all tables in schema relay from public, anon, authenticated;

-- Owner opens a one-time invite (any id); a can_invite member opens one limited to its own machine prefix
-- (own id up to and including the first '-'). The invitee picks id / name / kind / machine at register time.
drop function if exists public.irori_relay_invite(text, text, text, text);
create or replace function public.irori_relay_invite(p_node text, p_code_hash text, p_note text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_me relay.nodes%rowtype;
  v_prefix text;
  v_exp timestamptz;
begin
  select * into v_me from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if v_me.role = 'owner' then
    v_prefix := null;
  elsif v_me.can_invite then
    v_prefix := split_part(v_me.id, '-', 1) || '-';
  else
    return jsonb_build_object('error', 'forbidden');
  end if;
  delete from relay.invites where expires_at < now() - interval '1 day';
  insert into relay.invites (code_hash, prefix, note, created_by)
    values (p_code_hash, v_prefix, left(p_note, 200), p_node)
    returning expires_at into v_exp;
  return jsonb_build_object('expires_at', v_exp, 'prefix', v_prefix);
end;
$$;

-- Owner: key-reset code (15 minutes, one-time) for a member still on the list.
create or replace function public.irori_relay_reissue(p_node text, p_code_hash text, p_id text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_exp timestamptz;
begin
  if not exists (select 1 from relay.nodes where id = p_node and role = 'owner' and status = 'active') then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not exists (select 1 from relay.nodes where id = p_id and status = 'active') then
    return jsonb_build_object('error', 'not_found');
  end if;
  insert into relay.invites (code_hash, reissue_for, created_by)
    values (p_code_hash, p_id, p_node)
    returning expires_at into v_exp;
  return jsonb_build_object('expires_at', v_exp);
end;
$$;

-- Redeem a reset code: new key + new bell topic, old key dies at once, inbox untouched.
create or replace function public.irori_relay_redeem_reissue(
  p_ip_hash text, p_code_hash text, p_id text, p_key_hash text, p_bell_topic text
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
  if not found or v_inv.used_at is not null or v_inv.expires_at < now()
     or v_inv.reissue_for is null or v_inv.reissue_for <> p_id then
    return jsonb_build_object('error', 'invalid_invite');
  end if;
  update relay.nodes set key_hash = p_key_hash, bell_topic = p_bell_topic, last_seen_at = now()
    where id = p_id and status = 'active';
  if not found then
    return jsonb_build_object('error', 'invalid_invite');
  end if;
  update relay.invites set used_at = now() where code_hash = p_code_hash;
  return jsonb_build_object('id', p_id, 'bell_topic', p_bell_topic);
end;
$$;

-- Register with an invite: one-time, 15 minutes, invitee picks the id (must start with the invite prefix, if any); 10 attempts per IP per hour. Role is always member.
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
  if not found or v_inv.used_at is not null or v_inv.expires_at < now() or v_inv.reissue_for is not null
     or (v_inv.for_id is not null and v_inv.for_id <> p_id) then
    return jsonb_build_object('error', 'invalid_invite');
  end if;
  if p_id !~ '^[A-Za-z0-9_-]{1,32}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if v_inv.prefix is not null and left(p_id, char_length(v_inv.prefix)) <> v_inv.prefix then
    return jsonb_build_object('error', 'bad_id_prefix', 'prefix', v_inv.prefix);
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

-- Roster: a machine node (can_invite) reports the Claude windows running on it; each report replaces the whole list.
create table if not exists relay.roster (
  node text not null references relay.nodes(id),
  name text not null,
  status text,
  cwd_label text,
  seen_at timestamptz not null default now(),
  primary key (node, name)
);
alter table relay.roster enable row level security;
revoke all on relay.roster from public, anon, authenticated;

create or replace function public.irori_relay_roster(p_node text, p_agents jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_n int;
begin
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active' and can_invite) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_agents is null or jsonb_typeof(p_agents) <> 'array' or jsonb_array_length(p_agents) > 100 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_agents) a
    where jsonb_typeof(a) <> 'object' or jsonb_typeof(a->'name') is distinct from 'string'
       or char_length(a->>'name') not between 1 and 60
       or char_length(coalesce(a->>'status', '')) > 20 or char_length(coalesce(a->>'cwd_label', '')) > 80
  ) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  delete from relay.roster where node = p_node;
  -- same name twice in one report: the last one wins
  insert into relay.roster (node, name, status, cwd_label)
    select distinct on (a.v->>'name') p_node, a.v->>'name', nullif(a.v->>'status', ''), nullif(a.v->>'cwd_label', '')
    from jsonb_array_elements(p_agents) with ordinality as a(v, ord)
    order by a.v->>'name', a.ord desc;
  get diagnostics v_n = row_count;
  return jsonb_build_object('count', v_n);
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
    'last_seen_at', n.last_seen_at,
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', r.status, 'cwd_label', r.cwd_label) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at > now() - interval '3 minutes'
    ), '[]'::jsonb)) order by n.id), '[]'::jsonb)
  from relay.nodes n where n.status = 'active';
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.irori_relay_invite(text,text,text)',
    'public.irori_relay_reissue(text,text,text)',
    'public.irori_relay_redeem_reissue(text,text,text,text,text)',
    'public.irori_relay_register(text,text,text,text,text,text,text,text,text)',
    'public.irori_relay_leave(text)',
    'public.irori_relay_update(text,text,text,text)',
    'public.irori_relay_roster(text,jsonb)',
    'public.irori_relay_list()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
