-- 05_rooms.sql：Relay 群組（第一階段）。規劃見 docs/relay/GROUPS.md（文末「裁示」優先）。
-- 執行方式：npx supabase db query --linked -f supabase/sql/05_rooms.sql（可重複執行；先於 irori-relay／irori-api 部署）
-- 權限設計（延續 01／02：relay schema 不暴露 PostgREST，只走 public.irori_relay_room_* 的 SECURITY DEFINER 函式，只授權 service_role）：
--   * 建群組／加人／移人／改置頂 只有「owner 節點」呼叫得動（函式內檢查 p_actor 的 role＝owner）。
--     這些函式只有 irori-api（小良哥登入後）會呼叫；irori-relay 對所有節點金鑰（含希緒 XISU）一律回 403，不接到這些函式。
--   * 發言／讀／列表／讀置頂：呼叫者必須是該群組的現役成員（成員 key＝節點代號，或「節點~視窗名」）。
--     節點只能代發「自己節點底下」的視窗（key 前綴＝自己），且視窗名必須在該節點的 roster 內。
--   * 小良哥本人是每個群組自動建立的成員，key 固定為 '~owner'（節點代號不可能含 ~，不會撞名），不能移出。
--   * 每成員每群組每小時最多 20 則（超過回 rate_limited；小良哥本人不限）。

create table if not exists relay.rooms (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{1,32}$'),
  name text not null check (char_length(name) between 1 and 60),
  created_by text not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  last_seq bigint not null default 0
);

create table if not exists relay.room_members (
  room_id text not null references relay.rooms(id),
  member text not null check (char_length(member) between 1 and 120),
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  read_seq bigint not null default 0,
  primary key (room_id, member)
);

create table if not exists relay.room_messages (
  room_id text not null references relay.rooms(id),
  seq bigint not null,
  from_member text not null,
  trust text not null check (trust in ('owner', 'member')),
  body text not null check (char_length(body) between 1 and 20000),
  mentions text[] not null default '{}',
  at timestamptz not null default now(),
  primary key (room_id, seq)
);
create index if not exists room_messages_rate_idx on relay.room_messages (room_id, from_member, at);

create table if not exists relay.room_pins (
  room_id text primary key references relay.rooms(id),
  body text not null default '' check (char_length(body) <= 20000),
  updated_by text,
  updated_at timestamptz not null default now(),
  version integer not null default 0
);

alter table relay.rooms enable row level security;
alter table relay.room_members enable row level security;
alter table relay.room_messages enable row level security;
alter table relay.room_pins enable row level security;
revoke all on all tables in schema relay from public, anon, authenticated;

-- ── 內部小工具（relay schema 不對外，呼叫者只有下面的 public 函式）──

create or replace function relay.room_actor_is_owner(p_node text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from relay.nodes where id = p_node and role = 'owner' and status = 'active');
$$;

-- 成員 key 是否有效：'~owner'、現役節點、或「現役節點~roster 上的視窗名」
create or replace function relay.room_key_ok(p_key text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case
    when p_key is null or char_length(p_key) not between 1 and 120 then false
    when p_key = '~owner' then true
    when position('~' in p_key) = 0 then exists (select 1 from relay.nodes where id = p_key and status = 'active')
    else exists (select 1 from relay.nodes where id = split_part(p_key, '~', 1) and status = 'active')
         and exists (select 1 from relay.roster where node = split_part(p_key, '~', 1)
                     and name = substr(p_key, position('~' in p_key) + 1))
  end;
$$;

create or replace function relay.room_member_name(p_key text)
returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when p_key = '~owner' then '小良哥'
    when position('~' in p_key) > 0 then substr(p_key, position('~' in p_key) + 1)
    else coalesce((select name from relay.nodes where id = p_key), p_key)
  end;
$$;

-- 呼叫者的成員 key：owner 模式要求 p_node 是 owner 節點（→ '~owner'）；否則節點本身，或帶視窗名＝「節點~視窗名」。null＝不合法
create or replace function relay.room_caller_key(p_node text, p_agent text, p_owner boolean)
returns text
language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_owner then
    return case when relay.room_actor_is_owner(p_node) then '~owner' end;
  end if;
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active') then
    return null;
  end if;
  if p_agent is null or btrim(p_agent) = '' then
    return p_node;
  end if;
  if position('~' in p_agent) > 0 or char_length(p_agent) > 60 then
    return null;
  end if;
  return p_node || '~' || p_agent;
end;
$$;

create or replace function relay.room_is_member(p_room text, p_key text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from relay.room_members m join relay.rooms r on r.id = m.room_id
    where m.room_id = p_room and m.member = p_key and m.left_at is null and r.archived_at is null
  );
$$;

create or replace function relay.room_members_json(p_room text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', m.member,
    'name', relay.room_member_name(m.member),
    'role', m.role,
    'kind', case when m.member = '~owner' then 'owner'
                 when position('~' in m.member) > 0 then 'window'
                 else coalesce(n.kind, 'other') end,
    'node_role', case when m.member = '~owner' then 'owner' else coalesce(n.role, 'member') end
  ) order by m.joined_at, m.member), '[]'::jsonb)
  from relay.room_members m
  left join relay.nodes n on n.id = split_part(m.member, '~', 1) and m.member <> '~owner'
  where m.room_id = p_room and m.left_at is null;
$$;

-- ── 只有 owner 節點（經 irori-api，小良哥登入）能呼叫：建群組／加人／移人／改置頂 ──

create or replace function public.irori_relay_room_create(p_actor text, p_id text, p_name text, p_members text[])
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  k text;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if not relay.room_actor_is_owner(p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_id is null or p_id !~ '^[A-Za-z0-9_-]{1,32}$' or char_length(v_name) not between 1 and 60
     or coalesce(array_length(p_members, 1), 0) > 50 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if exists (select 1 from relay.rooms where id = p_id) then
    return jsonb_build_object('error', 'id_taken');
  end if;
  foreach k in array coalesce(p_members, array[]::text[]) loop
    if k <> '~owner' and not relay.room_key_ok(k) then
      return jsonb_build_object('error', 'bad_member', 'member', k);
    end if;
  end loop;
  insert into relay.rooms (id, name, created_by) values (p_id, v_name, p_actor);
  insert into relay.room_members (room_id, member, role) values (p_id, '~owner', 'owner');
  insert into relay.room_members (room_id, member, role)
    select distinct p_id, m, 'member' from unnest(coalesce(p_members, array[]::text[])) m where m <> '~owner';
  insert into relay.room_pins (room_id) values (p_id);
  return jsonb_build_object('id', p_id);
exception when unique_violation then
  return jsonb_build_object('error', 'id_taken');
end;
$$;

create or replace function public.irori_relay_room_add(p_actor text, p_room text, p_member text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_last bigint;
begin
  if not relay.room_actor_is_owner(p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select last_seq into v_last from relay.rooms where id = p_room and archived_at is null;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_member = '~owner' then
    return jsonb_build_object('ok', true);
  end if;
  if not relay.room_key_ok(p_member) then
    return jsonb_build_object('error', 'bad_member');
  end if;
  -- 新加入（或離開後重新加入）的成員從當下算起，未讀為 0；要看歷史自己用 since 讀
  insert into relay.room_members (room_id, member, role, read_seq) values (p_room, p_member, 'member', v_last)
    on conflict (room_id, member) do update set left_at = null, joined_at = now(), read_seq = v_last
    where relay.room_members.left_at is not null;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.irori_relay_room_remove(p_actor text, p_room text, p_member text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if not relay.room_actor_is_owner(p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_member = '~owner' then
    return jsonb_build_object('error', 'cannot_remove_owner');
  end if;
  update relay.room_members set left_at = now()
    where room_id = p_room and member = p_member and left_at is null;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- 改置頂「現況」：樂觀鎖。p_version 必須等於目前版本，否則回 version_conflict（帶目前版本）
create or replace function public.irori_relay_room_pin_set(p_actor text, p_room text, p_body text, p_version integer)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_new integer;
  v_cur integer;
begin
  if not relay.room_actor_is_owner(p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_body is null or char_length(p_body) > 20000 or p_version is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.room_pins set body = p_body, version = version + 1, updated_by = '~owner', updated_at = now()
    where room_id = p_room and version = p_version
    returning version into v_new;
  if v_new is null then
    select version into v_cur from relay.room_pins where room_id = p_room;
    if not found then
      return jsonb_build_object('error', 'not_found');
    end if;
    return jsonb_build_object('error', 'version_conflict', 'version', v_cur);
  end if;
  return jsonb_build_object('version', v_new);
end;
$$;

-- ── 成員（節點、視窗、希緒、小良哥）用：呼叫者必須是該群組現役成員 ──
-- 呼叫者身分三個參數：p_node（金鑰決定的節點，或 owner 節點）、p_agent（節點代發視窗時帶視窗名）、p_owner（true＝小良哥，p_node 必須是 owner 節點）

create or replace function public.irori_relay_room_list(p_node text, p_owner boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_out jsonb;
begin
  if p_owner and not relay.room_actor_is_owner(p_node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'name', r.name, 'created_at', r.created_at, 'last_seq', r.last_seq,
    'last_at', lm.at, 'last_from', lm.from_member,
    'last_from_name', case when lm.from_member is null then null else relay.room_member_name(lm.from_member) end,
    'last_body', left(lm.body, 120),
    'mine', (select coalesce(jsonb_agg(jsonb_build_object(
        'member', rm.member, 'read_seq', rm.read_seq,
        'unread', (select count(*) from relay.room_messages m
                   where m.room_id = r.id and m.seq > rm.read_seq and m.from_member <> rm.member)
      ) order by rm.member), '[]'::jsonb)
      from relay.room_members rm
      where rm.room_id = r.id and rm.left_at is null
        and case when p_owner then rm.member = '~owner'
                 else (rm.member = p_node or left(rm.member, char_length(p_node) + 1) = p_node || '~') end),
    'members', relay.room_members_json(r.id)
  ) order by coalesce(lm.at, r.created_at) desc), '[]'::jsonb)
  into v_out
  from relay.rooms r
  left join lateral (
    select m.at, m.from_member, m.body from relay.room_messages m where m.room_id = r.id order by m.seq desc limit 1
  ) lm on true
  where r.archived_at is null
    and exists (
      select 1 from relay.room_members rm
      where rm.room_id = r.id and rm.left_at is null
        and case when p_owner then rm.member = '~owner'
                 else (rm.member = p_node or left(rm.member, char_length(p_node) + 1) = p_node || '~') end
    );
  return jsonb_build_object('rooms', v_out);
end;
$$;

create or replace function public.irori_relay_room_members(p_node text, p_agent text, p_room text, p_owner boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_key text := relay.room_caller_key(p_node, p_agent, p_owner);
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not relay.room_is_member(p_room, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  return jsonb_build_object('key', v_key,
    'room', (select jsonb_build_object('id', r.id, 'name', r.name) from relay.rooms r where r.id = p_room),
    'members', relay.room_members_json(p_room));
end;
$$;

create or replace function public.irori_relay_room_pin_get(p_node text, p_agent text, p_room text, p_owner boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_key text := relay.room_caller_key(p_node, p_agent, p_owner);
  v_pin relay.room_pins%rowtype;
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not relay.room_is_member(p_room, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  select * into v_pin from relay.room_pins where room_id = p_room;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('body', v_pin.body, 'version', v_pin.version, 'updated_at', v_pin.updated_at);
end;
$$;

-- 發言。每成員每群組每小時 20 則（小良哥不限）；提到的人只留現役成員、最多 8 位；回傳要敲門鈴的頻道（每個成員節點一個，不帶內容）
create or replace function public.irori_relay_room_post(
  p_node text, p_agent text, p_room text, p_body text, p_mentions text[], p_owner boolean default false
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_key text := relay.room_caller_key(p_node, p_agent, p_owner);
  v_trust text;
  v_seq bigint;
  v_mentions text[];
  v_topics text[];
  v_recent int;
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_body is null or char_length(p_body) < 1 or char_length(p_body) > 20000 then
    return jsonb_build_object('error', 'bad_body');
  end if;
  if not relay.room_is_member(p_room, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  -- 視窗代發：視窗名要在該節點最近回報的 roster 內（防節點亂掰名字）
  if not p_owner and p_agent is not null and btrim(p_agent) <> ''
     and not exists (select 1 from relay.roster where node = p_node and name = p_agent) then
    return jsonb_build_object('error', 'unknown_agent');
  end if;
  if v_key <> '~owner' then
    select count(*) into v_recent from relay.room_messages
      where room_id = p_room and from_member = v_key and at > now() - interval '1 hour';
    if v_recent >= 20 then
      return jsonb_build_object('error', 'rate_limited');
    end if;
  end if;
  v_trust := case when p_owner or relay.room_actor_is_owner(p_node) then 'owner' else 'member' end;
  select coalesce(array_agg(s.m), array[]::text[]) into v_mentions from (
    select distinct m from unnest(coalesce(p_mentions, array[]::text[])) m
    where m <> v_key and relay.room_is_member(p_room, m) order by m limit 8
  ) s;
  update relay.rooms set last_seq = last_seq + 1 where id = p_room returning last_seq into v_seq;
  insert into relay.room_messages (room_id, seq, from_member, trust, body, mentions)
    values (p_room, v_seq, v_key, v_trust, p_body, v_mentions);
  update relay.room_members set read_seq = v_seq where room_id = p_room and member = v_key;
  select coalesce(array_agg(distinct n.bell_topic), array[]::text[]) into v_topics
    from relay.room_members rm join relay.nodes n on n.id = split_part(rm.member, '~', 1) and n.status = 'active'
    where rm.room_id = p_room and rm.left_at is null and rm.member <> '~owner';
  return jsonb_build_object('seq', v_seq, 'from', v_key, 'bell_topics', to_jsonb(v_topics));
end;
$$;

-- 讀紀錄。省略 p_since：成員用自己的 read_seq 之後（p_tail 為 true 則改取最新 N 則）；有 p_since 則 seq > p_since。
-- 已讀位置只在「省略 p_since 且非 tail」或明確 p_mark＝true 時推進到這次回傳的最大 seq
create or replace function public.irori_relay_room_read(
  p_node text, p_agent text, p_room text, p_since bigint, p_limit integer, p_owner boolean default false,
  p_tail boolean default false, p_mark boolean default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_key text := relay.room_caller_key(p_node, p_agent, p_owner);
  v_read bigint;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_since bigint;
  v_msgs jsonb;
  v_max bigint;
  v_last bigint;
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not relay.room_is_member(p_room, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  select read_seq into v_read from relay.room_members where room_id = p_room and member = v_key;
  select last_seq into v_last from relay.rooms where id = p_room;
  v_since := coalesce(p_since, case when p_tail then null else v_read end);
  select coalesce(jsonb_agg(jsonb_build_object(
      'seq', s.seq, 'from', s.from_member, 'from_name', relay.room_member_name(s.from_member),
      'trust', s.trust, 'body', s.body, 'mentions', to_jsonb(s.mentions), 'at', s.at
    ) order by s.seq), '[]'::jsonb), max(s.seq)
  into v_msgs, v_max
  from (
    select * from (
      select m.* from relay.room_messages m
      where m.room_id = p_room and (v_since is null or m.seq > v_since)
      order by case when v_since is null then -m.seq else m.seq end
      limit v_limit
    ) t
  ) s;
  if v_max is not null and coalesce(p_mark, p_since is null and not coalesce(p_tail, false)) then
    update relay.room_members set read_seq = greatest(read_seq, v_max) where room_id = p_room and member = v_key;
  end if;
  return jsonb_build_object('messages', v_msgs, 'last_seq', v_last, 'key', v_key);
end;
$$;

-- 視窗是否在節點最近回報的 roster 內（irori-relay 代發前檢查用）
create or replace function public.irori_relay_roster_has(p_node text, p_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from relay.roster where node = p_node and name = p_name);
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.irori_relay_room_create(text,text,text,text[])',
    'public.irori_relay_room_add(text,text,text)',
    'public.irori_relay_room_remove(text,text,text)',
    'public.irori_relay_room_pin_set(text,text,text,integer)',
    'public.irori_relay_room_list(text,boolean)',
    'public.irori_relay_room_members(text,text,text,boolean)',
    'public.irori_relay_room_pin_get(text,text,text,boolean)',
    'public.irori_relay_room_post(text,text,text,text,text[],boolean)',
    'public.irori_relay_room_read(text,text,text,bigint,integer,boolean,boolean,boolean)',
    'public.irori_relay_roster_has(text,text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
