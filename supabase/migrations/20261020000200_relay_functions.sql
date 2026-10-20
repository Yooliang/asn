-- 收發室函式（asn 專案）：依 2026-10-20 舊後台實際的函式定義（pg_get_functiondef）整理。
-- 函式名稱維持 public.irori_relay_*（Edge Function 以 rpc 呼叫，不改名以免動到呼叫端）。
-- 不帶 Irori 專用的函式：relay.account_view（讀 irori.accounts）、
-- public.irori_relay_inbound／outbound／mark_read（讀寫 irori.kv）、無參數的 irori_relay_list() 與 irori_relay_list_by_node。
-- 權限：全部只授權 service_role。

-- ===== relay 內部輔助函式 =====

CREATE OR REPLACE FUNCTION relay.node_tenant(p_node text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select tenant_id from relay.nodes where id = p_node;
$function$;

CREATE OR REPLACE FUNCTION relay.room_actor_is_owner(p_node text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from relay.nodes where id = p_node and role = 'owner' and status = 'active');
$function$;

CREATE OR REPLACE FUNCTION relay.room_caller_key(p_node text, p_agent text, p_owner boolean)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION relay.room_in_tenant(p_room text, p_node text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from relay.rooms r where r.id = p_room and r.tenant_id is not distinct from relay.node_tenant(p_node));
$function$;

CREATE OR REPLACE FUNCTION relay.room_is_member(p_room text, p_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from relay.room_members m join relay.rooms r on r.id = m.room_id
    where m.room_id = p_room and m.member = p_key and m.left_at is null and r.archived_at is null
  );
$function$;

CREATE OR REPLACE FUNCTION relay.room_key_ok(p_key text, p_tenant uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when p_key is null or char_length(p_key) not between 1 and 120 then false
    when p_key = '~owner' then true
    when position('~' in p_key) = 0 then exists (
      select 1 from relay.nodes where id = p_key and status = 'active' and tenant_id is not distinct from p_tenant)
    else exists (
        select 1 from relay.nodes where id = split_part(p_key, '~', 1) and status = 'active' and tenant_id is not distinct from p_tenant)
      and exists (select 1 from relay.roster where node = split_part(p_key, '~', 1)
                  and name = substr(p_key, position('~' in p_key) + 1))
  end;
$function$;

CREATE OR REPLACE FUNCTION relay.room_key_ok(p_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when p_key is null or char_length(p_key) not between 1 and 120 then false
    when p_key = '~owner' then true
    when position('~' in p_key) = 0 then exists (select 1 from relay.nodes where id = p_key and status = 'active')
    else exists (select 1 from relay.nodes where id = split_part(p_key, '~', 1) and status = 'active')
         and exists (select 1 from relay.roster where node = split_part(p_key, '~', 1)
                     and name = substr(p_key, position('~' in p_key) + 1))
  end;
$function$;

CREATE OR REPLACE FUNCTION relay.room_member_name(p_key text, p_tenant uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when p_key = '~owner' then coalesce((select owner_name from relay.tenants where id = p_tenant), '主人')
    when position('~' in p_key) > 0 then substr(p_key, position('~' in p_key) + 1)
    else coalesce((select name from relay.nodes where id = p_key and tenant_id is not distinct from p_tenant), p_key)
  end;
$function$;

CREATE OR REPLACE FUNCTION relay.room_member_name(p_key text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when p_key = '~owner' then '小良哥'
    when position('~' in p_key) > 0 then substr(p_key, position('~' in p_key) + 1)
    else coalesce((select name from relay.nodes where id = p_key), p_key)
  end;
$function$;

CREATE OR REPLACE FUNCTION relay.room_members_json(p_room text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', m.member,
    'name', relay.room_member_name(m.member, r.tenant_id),
    'role', m.role,
    'kind', case when m.member = '~owner' then 'owner'
                 when position('~' in m.member) > 0 then 'window'
                 else coalesce(n.kind, 'other') end,
    'node_role', case when m.member = '~owner' then 'owner' else coalesce(n.role, 'member') end,
    'joined_via', m.joined_via
  ) order by m.joined_at, m.member), '[]'::jsonb)
  from relay.room_members m
  join relay.rooms r on r.id = m.room_id
  left join relay.nodes n on n.id = split_part(m.member, '~', 1) and m.member <> '~owner' and n.tenant_id is not distinct from r.tenant_id
  where m.room_id = p_room and m.left_at is null;
$function$;

-- ===== public.irori_relay_*（Edge Function 呼叫的入口）=====

CREATE OR REPLACE FUNCTION public.irori_relay_ack(p_node text, p_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n int;
begin
  update relay.messages set acked_at = now()
    where to_node = p_node and id = any(p_ids) and acked_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_ack_agent(p_node text, p_agent text, p_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n int;
begin
  if p_agent is null or p_agent = '' then return 0; end if;
  update relay.messages set acked_at = now()
    where to_node = p_node and to_agent = p_agent and id = any(p_ids) and acked_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_auth(p_key_hash text)
 RETURNS TABLE(id text, bell_topic text, role text, can_invite boolean, tenant_id uuid)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update relay.nodes n set last_seen_at = now()
    where n.key_hash = p_key_hash and n.status = 'active'
      and (n.tenant_id is null or exists (select 1 from relay.tenants t where t.id = n.tenant_id and t.status = 'active'))
    returning n.id, n.bell_topic, n.role, n.can_invite, n.tenant_id;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_get_avatar(p_tenant uuid, p_node text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((
    select jsonb_build_object('node', n.id, 'avatar', n.avatar, 'avatar_updated_at', n.avatar_updated_at)
    from relay.nodes n
    where n.id = p_node and n.status = 'active' and n.avatar is not null and n.tenant_id is not distinct from p_tenant
  ), jsonb_build_object('error', 'not_found'));
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_inbox(p_node text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      'reply_to', m.reply_to, 'created_at', m.created_at, 'expects_reply', m.expects_reply,
      'trust', case when f.role = 'owner' then 'owner' else 'member' end) order by m.created_at, m.id), '[]'::jsonb)
    into v_out from relay.messages m join relay.nodes f on f.id = m.from_node where m.id = any(v_ids);
  return v_out;
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_inbox_agent(p_node text, p_agent text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ids uuid[];
  v_out jsonb;
begin
  if p_agent is null or p_agent = '' then return '[]'::jsonb; end if;
  select coalesce(array_agg(s.id), array[]::uuid[]) into v_ids from (
    select m.id from relay.messages m
    where m.to_node = p_node and m.to_agent = p_agent and m.acked_at is null
    order by m.created_at, m.id limit 50
  ) s;
  update relay.messages set delivered_at = now()
    where id = any(v_ids) and delivered_at is null;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'from_node', m.from_node, 'from_agent', m.from_agent,
      'to_node', m.to_node, 'to_agent', m.to_agent, 'body', m.body,
      'reply_to', m.reply_to, 'created_at', m.created_at, 'expects_reply', m.expects_reply,
      'trust', case when f.role = 'owner' then 'owner' else 'member' end) order by m.created_at, m.id), '[]'::jsonb)
    into v_out from relay.messages m join relay.nodes f on f.id = m.from_node where m.id = any(v_ids);
  return v_out;
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_invite(p_node text, p_code_hash text, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    select id_prefix into v_prefix from relay.tenants where id = v_me.tenant_id;
  elsif v_me.can_invite then
    v_prefix := split_part(v_me.id, '-', 1) || '-';
  else
    return jsonb_build_object('error', 'forbidden');
  end if;
  delete from relay.invites where expires_at < now() - interval '1 day';
  insert into relay.invites (code_hash, prefix, note, created_by, tenant_id)
    values (p_code_hash, v_prefix, left(p_note, 200), p_node, v_me.tenant_id)
    returning expires_at into v_exp;
  return jsonb_build_object('expires_at', v_exp, 'prefix', v_prefix);
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_launch_name_ok(p_name text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select p_name is not null and p_name ~ '^[A-Za-z0-9一-鿿][A-Za-z0-9一-鿿-]{0,39}$';
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_launch(p_actor text, p_node text, p_profile text, p_name text, p_cwd text, p_first text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_l jsonb;
  v_topic text;
  v_max int;
  v_id uuid;
  v_t uuid;
begin
  select tenant_id into v_t from relay.nodes where id = p_actor and role = 'owner' and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select launcher, bell_topic into v_l, v_topic from relay.nodes
    where id = p_node and status = 'active' and tenant_id is not distinct from v_t;
  if v_topic is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_l is null then
    return jsonb_build_object('error', 'no_launcher');
  end if;
  if not public.irori_relay_launch_name_ok(p_name) then
    return jsonb_build_object('error', 'bad_name');
  end if;
  if p_profile is null or not exists (select 1 from jsonb_array_elements(v_l->'profiles') p where p->>'id' = p_profile) then
    return jsonb_build_object('error', 'bad_profile');
  end if;
  if p_cwd is null or not exists (select 1 from jsonb_array_elements_text(v_l->'cwd_allow') c where c = p_cwd) then
    return jsonb_build_object('error', 'bad_cwd');
  end if;
  if p_first is not null and char_length(p_first) > 4000 then
    return jsonb_build_object('error', 'bad_first_message');
  end if;
  if exists (select 1 from relay.roster where node = p_node and lower(name) = lower(p_name) and seen_at > now() - interval '3 minutes')
     or exists (select 1 from relay.launches where node = p_node and lower(name) = lower(p_name)
                and (status in ('pending', 'taken') and created_at > now() - interval '10 minutes'
                     or status in ('ok', 'unconfirmed') and done_at > now() - interval '3 minutes')) then
    return jsonb_build_object('error', 'name_taken');
  end if;
  v_max := coalesce((v_l->>'max_per_hour')::int, 6);
  if (select count(*) from relay.launches where node = p_node and created_at > now() - interval '1 hour') >= v_max then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.launches (requested_by, node, profile, name, cwd, first_message, tenant_id)
    values (p_actor, p_node, p_profile, p_name, p_cwd, nullif(p_first, ''), v_t)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_launch_pending(p_node text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_out jsonb;
begin
  update relay.launches set status = 'failed', detail = '機器橋 2 分鐘內沒有取走（電腦可能沒開或橋沒在跑）', done_at = now()
    where node = p_node and status = 'pending' and created_at <= now() - interval '2 minutes';
  with t as (
    update relay.launches set status = 'taken', taken_at = now()
      where node = p_node and status = 'pending'
      returning id, requested_by, profile, name, cwd, first_message, created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'requested_by', t.requested_by, 'profile', t.profile, 'name', t.name, 'cwd', t.cwd,
      'first_message', t.first_message, 'created_at', t.created_at) order by t.created_at), '[]'::jsonb)
    into v_out from t;
  return v_out;
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_launch_result(p_node text, p_id uuid, p_status text, p_detail text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n int;
begin
  if p_status not in ('ok', 'failed', 'unconfirmed') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.launches set status = p_status, detail = left(p_detail, 500), done_at = now()
    where id = p_id and node = p_node and status in ('taken', 'unconfirmed');
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_launchers(p_actor text, p_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_mach jsonb; v_recent jsonb; v_t uuid;
begin
  select tenant_id into v_t from relay.nodes where id = p_actor and role = 'owner' and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'node', n.id, 'name', n.name, 'machine', n.machine, 'launcher', n.launcher, 'launcher_at', n.launcher_at,
      'online', coalesce(n.last_seen_at > now() - interval '3 minutes', false)) order by n.id), '[]'::jsonb)
    into v_mach from relay.nodes n
    where n.status = 'active' and n.launcher is not null and n.tenant_id is not distinct from v_t;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'node', l.node, 'profile', l.profile, 'name', l.name, 'cwd', l.cwd,
      'status', case when l.status = 'pending' and l.created_at <= now() - interval '2 minutes' then 'failed' else l.status end,
      'detail', case when l.status = 'pending' and l.created_at <= now() - interval '2 minutes'
                     then '機器橋 2 分鐘內沒有取走（電腦可能沒開或橋沒在跑）' else l.detail end,
      'created_at', l.created_at, 'done_at', l.done_at) order by l.created_at desc), '[]'::jsonb)
    into v_recent from (
      select * from relay.launches
      where tenant_id is not distinct from v_t
        and ((p_ids is null and created_at > now() - interval '7 days') or id = any(p_ids))
      order by created_at desc limit 30
    ) l;
  return jsonb_build_object('machines', v_mach, 'launches', v_recent);
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_leave(p_node text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update relay.nodes set status = 'left', key_hash = 'revoked:' || gen_random_uuid()::text
    where id = p_node and status = 'active';
  return found;
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_list(p_tenant uuid)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id, 'name', n.name, 'kind', n.kind, 'machine', n.machine,
    'online', coalesce(n.last_seen_at > now() - interval '3 minutes', false),
    'presence', case when n.last_seen_at > now() - interval '3 minutes' then 'live'
                     when n.last_seen_at > now() - interval '24 hours' then 'recent' else 'idle' end,
    'last_seen_at', n.last_seen_at,
    'avatar_updated_at', case when n.avatar is null then null else n.avatar_updated_at end,
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', r.status, 'cwd_label', r.cwd_label, 'engine', r.engine) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at > now() - interval '3 minutes'
    ), '[]'::jsonb)) order by n.id), '[]'::jsonb)
  from relay.nodes n where n.status = 'active' and n.tenant_id is not distinct from p_tenant;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_redeem_reissue(p_ip_hash text, p_code_hash text, p_id text, p_key_hash text, p_bell_topic text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    where id = p_id and status = 'active' and tenant_id is not distinct from v_inv.tenant_id;
  if not found then
    return jsonb_build_object('error', 'invalid_invite');
  end if;
  update relay.invites set used_at = now() where code_hash = p_code_hash;
  return jsonb_build_object('id', p_id, 'bell_topic', p_bell_topic);
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_register(p_ip_hash text, p_code_hash text, p_id text, p_name text, p_kind text, p_machine text, p_note text, p_key_hash text, p_bell_topic text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_inv relay.invites%rowtype;
  v_n int;
  v_old uuid;
  v_has_old boolean;
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
  -- 「t<數字>-」開頭的代號是留給其他租戶的（沒有前綴限制的邀請，也就是租戶 1 的，不能佔用）
  if p_id ~ '^t[0-9]+-' and v_inv.prefix is null then
    return jsonb_build_object('error', 'id_taken');
  end if;
  select tenant_id, true into v_old, v_has_old from relay.nodes where id = p_id;
  if coalesce(v_has_old, false) and (
       exists (select 1 from relay.nodes where id = p_id and status = 'active')
       or v_old is distinct from v_inv.tenant_id
     ) then
    return jsonb_build_object('error', 'id_taken');
  end if;
  if p_kind is null or p_kind not in ('claude', 'gpt', 'gemini', 'grok', 'other') then
    p_kind := 'other';
  end if;

  insert into relay.nodes (id, name, key_hash, bell_topic, kind, role, can_invite, machine, note, status, last_seen_at, tenant_id)
    values (p_id, p_name, p_key_hash, p_bell_topic, p_kind, 'member', false, p_machine, left(p_note, 500), 'active', now(), v_inv.tenant_id)
    on conflict (id) do update set
      name = excluded.name, key_hash = excluded.key_hash, bell_topic = excluded.bell_topic,
      kind = excluded.kind, role = 'member', can_invite = false, machine = excluded.machine, note = excluded.note,
      status = 'active', last_seen_at = now();
  update relay.invites set used_at = now() where code_hash = p_code_hash;
  return jsonb_build_object('id', p_id, 'bell_topic', p_bell_topic);
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_reissue(p_node text, p_code_hash text, p_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_exp timestamptz;
  v_tenant uuid;
begin
  select tenant_id into v_tenant from relay.nodes where id = p_node and role = 'owner' and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not exists (select 1 from relay.nodes where id = p_id and status = 'active' and tenant_id is not distinct from v_tenant) then
    return jsonb_build_object('error', 'not_found');
  end if;
  insert into relay.invites (code_hash, reissue_for, created_by, tenant_id)
    values (p_code_hash, p_id, p_node, v_tenant)
    returning expires_at into v_exp;
  return jsonb_build_object('expires_at', v_exp);
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_room_add(p_actor text, p_room text, p_member text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_last bigint;
begin
  if not relay.room_actor_is_owner(p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select last_seq into v_last from relay.rooms
    where id = p_room and archived_at is null and tenant_id is not distinct from relay.node_tenant(p_actor);
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_member = '~owner' then
    return jsonb_build_object('ok', true);
  end if;
  if not relay.room_key_ok(p_member, relay.node_tenant(p_actor)) then
    return jsonb_build_object('error', 'bad_member');
  end if;
  insert into relay.room_members (room_id, member, role, read_seq) values (p_room, p_member, 'member', v_last)
    on conflict (room_id, member) do update set left_at = null, joined_at = now(), read_seq = v_last, joined_via = 'manual'
    where relay.room_members.left_at is not null;
  return jsonb_build_object('ok', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_room_auto_apply(p_node text, p_joins jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  j jsonb;
  v_last bigint;
  v_key text;
  v_added int := 0;
  v_left int := 0;
  v_keys text[] := array[]::text[];
  v_t uuid;
begin
  select tenant_id into v_t from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_joins is null or jsonb_typeof(p_joins) <> 'array' or jsonb_array_length(p_joins) > 500 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  for j in select * from jsonb_array_elements(p_joins) loop
    if jsonb_typeof(j->'room') is distinct from 'string' or jsonb_typeof(j->'name') is distinct from 'string' then
      continue;
    end if;
    if not exists (select 1 from relay.roster where node = p_node and name = j->>'name') then
      continue;
    end if;
    select last_seq into v_last from relay.rooms
      where id = j->>'room' and archived_at is null and tenant_id is not distinct from v_t and exists (
        select 1 from unnest(auto_prefixes) pf where left(j->>'name', char_length(pf)) = pf);
    if not found then
      continue;
    end if;
    v_key := p_node || '~' || (j->>'name');
    v_keys := array_append(v_keys, (j->>'room') || '|' || v_key);
    insert into relay.room_members (room_id, member, role, read_seq, joined_via)
      values (j->>'room', v_key, 'member', v_last, 'auto')
      on conflict (room_id, member) do update set left_at = null, joined_at = now(), read_seq = v_last
      where relay.room_members.left_at is not null and relay.room_members.joined_via = 'auto';
    if found then v_added := v_added + 1; end if;
  end loop;
  update relay.room_members m set left_at = now()
    where m.joined_via = 'auto' and m.left_at is null
      and left(m.member, char_length(p_node) + 1) = p_node || '~'
      and not ((m.room_id || '|' || m.member) = any (v_keys));
  get diagnostics v_left = row_count;
  return jsonb_build_object('added', v_added, 'left', v_left);
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_room_auto_rules()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('room', id, 'prefixes', to_jsonb(auto_prefixes))), '[]'::jsonb)
  from relay.rooms
  where archived_at is null and coalesce(array_length(auto_prefixes, 1), 0) > 0
    and tenant_id is not distinct from '00000000-0000-0000-0000-000000000001'::uuid;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_room_auto_rules(p_node text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('room', id, 'prefixes', to_jsonb(auto_prefixes))), '[]'::jsonb)
  from relay.rooms
  where archived_at is null and coalesce(array_length(auto_prefixes, 1), 0) > 0
    and tenant_id is not distinct from relay.node_tenant(p_node);
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_room_create(p_actor text, p_id text, p_name text, p_members text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  k text;
  v_name text := btrim(coalesce(p_name, ''));
  v_t uuid;
begin
  if not relay.room_actor_is_owner(p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  v_t := relay.node_tenant(p_actor);
  if p_id is null or p_id !~ '^[A-Za-z0-9_-]{1,32}$' or char_length(v_name) not between 1 and 60
     or coalesce(array_length(p_members, 1), 0) > 50 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if exists (select 1 from relay.rooms where id = p_id) then
    return jsonb_build_object('error', 'id_taken');
  end if;
  foreach k in array coalesce(p_members, array[]::text[]) loop
    if k <> '~owner' and not relay.room_key_ok(k, v_t) then
      return jsonb_build_object('error', 'bad_member', 'member', k);
    end if;
  end loop;
  insert into relay.rooms (id, name, created_by, tenant_id) values (p_id, v_name, p_actor, v_t);
  insert into relay.room_members (room_id, member, role) values (p_id, '~owner', 'owner');
  insert into relay.room_members (room_id, member, role)
    select distinct p_id, m, 'member' from unnest(coalesce(p_members, array[]::text[])) m where m <> '~owner';
  insert into relay.room_pins (room_id) values (p_id);
  return jsonb_build_object('id', p_id);
exception when unique_violation then
  return jsonb_build_object('error', 'id_taken');
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_room_list(p_node text, p_owner boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_out jsonb;
  v_t uuid := relay.node_tenant(p_node);
begin
  if p_owner and not relay.room_actor_is_owner(p_node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'name', r.name, 'created_at', r.created_at, 'last_seq', r.last_seq, 'auto_prefixes', to_jsonb(r.auto_prefixes),
    'last_at', lm.at, 'last_from', lm.from_member,
    'last_from_name', case when lm.from_member is null then null else relay.room_member_name(lm.from_member, v_t) end,
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
    and r.tenant_id is not distinct from v_t
    and exists (
      select 1 from relay.room_members rm
      where rm.room_id = r.id and rm.left_at is null
        and case when p_owner then rm.member = '~owner'
                 else (rm.member = p_node or left(rm.member, char_length(p_node) + 1) = p_node || '~') end
    );
  return jsonb_build_object('rooms', v_out);
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_room_members(p_node text, p_agent text, p_room text, p_owner boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_key text := relay.room_caller_key(p_node, p_agent, p_owner);
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not relay.room_in_tenant(p_room, p_node) or not relay.room_is_member(p_room, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  return jsonb_build_object('key', v_key,
    'room', (select jsonb_build_object('id', r.id, 'name', r.name, 'auto_prefixes', to_jsonb(r.auto_prefixes)) from relay.rooms r where r.id = p_room),
    'members', relay.room_members_json(p_room));
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_room_pin_get(p_node text, p_agent text, p_room text, p_owner boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_key text := relay.room_caller_key(p_node, p_agent, p_owner);
  v_pin relay.room_pins%rowtype;
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not relay.room_in_tenant(p_room, p_node) or not relay.room_is_member(p_room, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  select * into v_pin from relay.room_pins where room_id = p_room;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('body', v_pin.body, 'version', v_pin.version, 'updated_at', v_pin.updated_at);
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_room_pin_set(p_actor text, p_room text, p_body text, p_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if not relay.room_in_tenant(p_room, p_actor) then
    return jsonb_build_object('error', 'not_found');
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
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_room_post(p_node text, p_agent text, p_room text, p_body text, p_mentions text[], p_owner boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_key text := relay.room_caller_key(p_node, p_agent, p_owner);
  v_trust text;
  v_seq bigint;
  v_mentions text[];
  v_topics text[];
  v_recent int;
  v_t uuid := relay.node_tenant(p_node);
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_body is null or char_length(p_body) < 1 or char_length(p_body) > 20000 then
    return jsonb_build_object('error', 'bad_body');
  end if;
  if not relay.room_in_tenant(p_room, p_node) or not relay.room_is_member(p_room, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
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
      and n.tenant_id is not distinct from v_t
    where rm.room_id = p_room and rm.left_at is null and rm.member <> '~owner';
  return jsonb_build_object('seq', v_seq, 'from', v_key, 'bell_topics', to_jsonb(v_topics));
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_room_read(p_node text, p_agent text, p_room text, p_since bigint, p_limit integer, p_owner boolean DEFAULT false, p_tail boolean DEFAULT false, p_mark boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_key text := relay.room_caller_key(p_node, p_agent, p_owner);
  v_read bigint;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_since bigint;
  v_msgs jsonb;
  v_max bigint;
  v_last bigint;
  v_t uuid := relay.node_tenant(p_node);
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not relay.room_in_tenant(p_room, p_node) or not relay.room_is_member(p_room, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  select read_seq into v_read from relay.room_members where room_id = p_room and member = v_key;
  select last_seq into v_last from relay.rooms where id = p_room;
  v_since := coalesce(p_since, case when p_tail then null else v_read end);
  select coalesce(jsonb_agg(jsonb_build_object(
      'seq', s.seq, 'from', s.from_member, 'from_name', relay.room_member_name(s.from_member, v_t),
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
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_room_remove(p_actor text, p_room text, p_member text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not relay.room_actor_is_owner(p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_member = '~owner' then
    return jsonb_build_object('error', 'cannot_remove_owner');
  end if;
  update relay.room_members set left_at = now(), joined_via = 'manual'
    where room_id = p_room and member = p_member and left_at is null and relay.room_in_tenant(p_room, p_actor);
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_room_set_prefixes(p_actor text, p_room text, p_prefixes text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare k text;
begin
  if not relay.room_actor_is_owner(p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_prefixes is null or coalesce(array_length(p_prefixes, 1), 0) > 10 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  foreach k in array p_prefixes loop
    if k is null or char_length(k) not between 1 and 40 or btrim(k) = '' or position('~' in k) > 0 then
      return jsonb_build_object('error', 'bad_request');
    end if;
  end loop;
  update relay.rooms set auto_prefixes = (select coalesce(array_agg(distinct x), array[]::text[]) from unnest(p_prefixes) x)
    where id = p_room and archived_at is null and tenant_id is not distinct from relay.node_tenant(p_actor);
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_roster(p_node text, p_agents jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n int;
begin
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active' and (can_invite or can_roster)) then
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
  -- same name twice in one report: the last one wins；engine 格式不對就當沒帶（不因此整份名單被拒）
  insert into relay.roster (node, name, status, cwd_label, engine)
    select distinct on (a.v->>'name') p_node, a.v->>'name', nullif(a.v->>'status', ''), nullif(a.v->>'cwd_label', ''),
           case when a.v->>'engine' ~ '^[a-z][a-z0-9_-]{0,19}$' then a.v->>'engine' end
    from jsonb_array_elements(p_agents) with ordinality as a(v, ord)
    order by a.v->>'name', a.ord desc;
  get diagnostics v_n = row_count;
  return jsonb_build_object('count', v_n);
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_roster_has(p_node text, p_name text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from relay.roster where node = p_node and name = p_name);
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_send(p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid, p_expects_reply boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_topic text;
  v_id uuid;
  v_recent int;
  v_tenant uuid;
  v_to text := p_to_node;
  v_char text;
begin
  if p_body is null or char_length(p_body) < 1 or char_length(p_body) > 20000 then
    return jsonb_build_object('error', 'bad_body');
  end if;
  select tenant_id into v_tenant from relay.nodes where id = p_from_node;
  if v_to = 'XISU' then
    select character_node into v_char from relay.tenants where id = v_tenant;
    if v_char is not null then v_to := v_char; end if;
  end if;
  select bell_topic into v_topic from relay.nodes
    where id = v_to and status = 'active' and tenant_id is not distinct from v_tenant;
  if v_topic is null then
    return jsonb_build_object('error', 'unknown_to_node');
  end if;
  select count(*) into v_recent from relay.messages
    where from_node = p_from_node and created_at > now() - interval '1 minute';
  if v_recent >= 30 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  if p_reply_to is not null and not exists (
    select 1 from relay.messages where id = p_reply_to and tenant_id is not distinct from v_tenant
  ) then
    p_reply_to := null;
  end if;
  insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply)
    values (p_from_node, p_from_agent, v_to, p_to_agent, p_body, p_reply_to, v_tenant, p_expects_reply)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_sent_status(p_node text, p_ids uuid[])
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'delivered_at', m.delivered_at, 'acked_at', m.acked_at)), '[]'::jsonb)
  from relay.messages m
  where m.from_node = p_node and m.id = any(coalesce(p_ids, array[]::uuid[]));
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_set_avatar(p_node text, p_avatar text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_at timestamptz;
begin
  if p_avatar is not null and (
    char_length(p_avatar) > 48000
    or p_avatar !~ '^data:image/(png|webp);base64,[A-Za-z0-9+/]+={0,2}$'
  ) then
    return jsonb_build_object('error', 'bad_avatar');
  end if;
  update relay.nodes set avatar = p_avatar, avatar_updated_at = case when p_avatar is null then null else now() end
    where id = p_node and status = 'active'
    returning avatar_updated_at into v_at;
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  return jsonb_build_object('ok', true, 'avatar_updated_at', v_at);
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_set_launcher(p_node text, p_launcher jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active' and (can_invite or can_roster)) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_launcher is not null and (
       jsonb_typeof(p_launcher) <> 'object'
    or jsonb_typeof(p_launcher->'profiles') is distinct from 'array'
    or jsonb_typeof(p_launcher->'cwd_allow') is distinct from 'array'
    or jsonb_array_length(p_launcher->'profiles') > 20
    or jsonb_array_length(p_launcher->'cwd_allow') > 50
    or octet_length(p_launcher::text) > 16000
    or exists (select 1 from jsonb_array_elements(p_launcher->'profiles') p
               where jsonb_typeof(p->'id') is distinct from 'string' or char_length(p->>'id') not between 1 and 40
                  or char_length(coalesce(p->>'label', '')) > 60)
    or exists (select 1 from jsonb_array_elements(p_launcher->'cwd_allow') c
               where jsonb_typeof(c) <> 'string' or char_length(c #>> '{}') not between 1 and 260)
  ) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.nodes set launcher = case when p_launcher is null then null else jsonb_build_object(
      'profiles', p_launcher->'profiles', 'cwd_allow', p_launcher->'cwd_allow',
      'max_per_hour', least(greatest(coalesce((p_launcher->>'max_per_hour')::int, 6), 1), 20)) end,
    launcher_at = now()
  where id = p_node;
  return jsonb_build_object('ok', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_update(p_node text, p_id text, p_machine text, p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from relay.nodes where id = p_node and role = 'owner' and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if (p_machine is not null and char_length(p_machine) not between 1 and 40)
     or (p_name is not null and char_length(p_name) not between 1 and 100)
     or (p_machine is null and p_name is null) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.nodes set machine = coalesce(p_machine, machine), name = coalesce(p_name, name)
    where id = p_id and status = 'active' and tenant_id is not distinct from v_tenant;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.irori_relay_whoami(p_tenant uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((
    select jsonb_build_object('node', n.id, 'bell_topic', n.bell_topic)
    from relay.tenants t join relay.nodes n on n.id = t.character_node and n.status = 'active'
    where t.id = p_tenant
  ), 'null'::jsonb);
$function$;

-- ===== 權限：只給 service_role =====
revoke all on all functions in schema relay from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
