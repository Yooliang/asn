-- 真人好友與群組 第 1a 期（後台）之三：人的動作（建群組、邀請、接受、一對一升級、退出、帶自己的 AI）與危險操作的主持人確認。
-- 所有「人的動作」函式的第一個參數是已驗過的登入使用者（Edge 驗 x-asn-user 後帶入），並再核對「這個節點是這個人的」（asn_user_owns_node）；
-- 節點金鑰單獨呼叫不到這些函式的入口（Edge 端 401／403）。只授權 service_role。命名照 asn_relay_ 慣例。
-- 規格：docs/design/HUMANS-AND-GROUPS.md 第 0、2.2、2.3、7 節。
begin;

-- ===== 內部輔助 =====

create or replace function relay.group_new_id()
 returns text language sql volatile set search_path to ''
as $function$ select 'g' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12); $function$;

-- 加入一個真人成員（角色、加入方式、可見起點）
create or replace function relay.group_add_human(p_room text, p_user uuid, p_role text, p_via text, p_vis bigint)
 returns void language plpgsql security definer set search_path to ''
as $function$
begin
  insert into relay.room_members (room_id, member, role, joined_via, user_id, display_name, visible_from_seq, read_seq)
    values (p_room, '~u:' || p_user::text, p_role, p_via, p_user,
            (select t.owner_name from relay.tenants t where t.owner_user = p_user), p_vis, p_vis)
  on conflict (room_id, member) do update
    set left_at = null, joined_at = now(), role = excluded.role, joined_via = excluded.joined_via,
        visible_from_seq = excluded.visible_from_seq, read_seq = excluded.read_seq, user_id = excluded.user_id,
        display_name = excluded.display_name;
end;
$function$;

-- 加入一個 AI 視窗成員（主人是 p_user）
create or replace function relay.group_add_ai(p_room text, p_key text, p_user uuid, p_via text, p_vis bigint)
 returns void language plpgsql security definer set search_path to ''
as $function$
begin
  insert into relay.room_members (room_id, member, role, joined_via, user_id, display_name, visible_from_seq, read_seq)
    values (p_room, p_key, 'member', p_via, p_user,
            case when position('~' in p_key) > 0 then substr(p_key, position('~' in p_key) + 1) else p_key end, p_vis, p_vis)
  on conflict (room_id, member) do update
    set left_at = null, joined_at = now(), joined_via = excluded.joined_via,
        visible_from_seq = excluded.visible_from_seq, read_seq = excluded.read_seq, user_id = excluded.user_id,
        display_name = excluded.display_name;
end;
$function$;

-- 系統訊息（誰加入、誰離開、複製了幾則）：不叫醒任何 AI、不計額度
create or replace function relay.group_system_msg(p_room text, p_from text, p_body text)
 returns bigint language sql security definer set search_path to ''
as $function$
  select relay.room_append(p_room, p_from, 'member', p_body, '{}'::text[], 'system', false, null);
$function$;

-- 是不是呼叫者租戶名下、已在名單的視窗鍵（節點~視窗名）
create or replace function relay.group_own_window(p_key text, p_tenant uuid)
 returns boolean language sql stable security definer set search_path to ''
as $function$
  select p_key is not null and p_key !~ '^~' and position('~' in p_key) > 1 and relay.room_key_ok(p_key, p_tenant);
$function$;

-- 目前人數（含 AI）與真人數
create or replace function relay.group_counts(p_room text)
 returns table(total integer, humans integer, cap integer) language sql stable security definer set search_path to ''
as $function$
  select count(*)::int, count(*) filter (where m.member like '~u:%' or m.member = '~owner')::int, (select r.member_cap from relay.rooms r where r.id = p_room)
  from relay.room_members m where m.room_id = p_room and m.left_at is null;
$function$;

-- 這個人參加與建立的群組數是否已達上限（建立 20、參加 50）
create or replace function relay.group_limit_hit(p_user uuid, p_creating boolean)
 returns boolean language sql stable security definer set search_path to ''
as $function$
  select (p_creating and (select count(*) from relay.rooms r where r.created_by_user = p_user and r.archived_at is null) >= 20)
      or (select count(*) from relay.room_members m join relay.rooms r on r.id = m.room_id
          where m.member = '~u:' || p_user::text and m.left_at is null and r.archived_at is null) >= 50;
$function$;

-- 一對一升級成新群組：建群組、放入本人與那個 AI（與額外的 AI）、複製最後 p_seed 則往來當開頭紀錄。
-- 原一對一信件（relay.messages）完全不動；複製的開頭紀錄標 is_seed，不叫醒 AI、不計額度、不敲門鈴；附件不複製。
create or replace function relay.group_build_upgrade(p_user uuid, p_src_node text, p_src_agent text, p_seed integer, p_name text, p_extra text[])
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_t uuid := relay.user_tenant(p_user);
  v_alias text := public.asn_person_alias(p_user);
  v_src text := case when coalesce(p_src_agent, '') = '' then p_src_node else p_src_node || '~' || p_src_agent end;
  v_id text := relay.group_new_id();
  v_oname text := (select t.owner_name from relay.tenants t where t.id = relay.user_tenant(p_user));
  v_name text;
  v_n integer := least(greatest(coalesce(p_seed, 40), 0), 50);
  v_copied integer := 0;
  v_last bigint;
  k text;
  r record;
begin
  v_name := left(coalesce(nullif(btrim(p_name), ''),
    v_oname || ' 與 ' || case when coalesce(p_src_agent, '') = '' then p_src_node else p_src_agent end || ' 的群組'), 60);
  insert into relay.rooms (id, name, created_by, tenant_id, created_by_user, origin)
    values (v_id, v_name, '~u:' || p_user::text, v_t, p_user,
            jsonb_build_object('node', p_src_node, 'agent', nullif(p_src_agent, '')));
  insert into relay.room_pins (room_id) values (v_id);
  perform relay.group_add_human(v_id, p_user, 'owner', 'upgrade', 0);
  perform relay.group_add_ai(v_id, v_src, p_user, 'upgrade', 0);
  foreach k in array coalesce(p_extra, array[]::text[]) loop
    if k <> v_src then perform relay.group_add_ai(v_id, k, p_user, 'upgrade', 0); end if;
  end loop;
  if v_n > 0 then
    for r in
      select * from (
        select (array_agg(m.body order by m.created_at, m.id))[1] as body,
               case when bool_or(m.from_agent = v_alias) then 'me' else 'them' end as dir,
               min(m.created_at) as at
        from relay.messages m
        where m.tenant_id = v_t and m.person_user = p_user
          and ((m.from_agent = v_alias and m.to_node = p_src_node and coalesce(m.to_agent, '') = coalesce(p_src_agent, ''))
            or (m.from_agent is distinct from v_alias and m.from_node = p_src_node and coalesce(m.from_agent, '') = coalesce(p_src_agent, '')))
        group by coalesce(m.fanout_id, m.id)
        order by min(m.created_at) desc limit v_n
      ) g order by g.at
    loop
      perform relay.room_append(v_id, case when r.dir = 'me' then '~u:' || p_user::text else v_src end,
                                case when r.dir = 'me' then 'owner' else 'member' end, left(r.body, 20000), '{}'::text[],
                                case when r.dir = 'me' then 'human' else 'ai' end, true,
                                case when r.dir = 'me' then p_user end, r.at);
      v_copied := v_copied + 1;
    end loop;
  end if;
  select last_seq into v_last from relay.rooms where id = v_id;
  update relay.room_members set read_seq = v_last where room_id = v_id;   -- 開頭紀錄不算未讀
  if v_copied > 0 then
    perform relay.group_system_msg(v_id, '~u:' || p_user::text, '這個群組由一對一對話升級而來，前面 ' || v_copied || ' 則是複製的開頭紀錄。');
  end if;
  return jsonb_build_object('id', v_id, 'name', v_name, 'copied', v_copied);
end;
$function$;

-- ===== 建群組 =====
create or replace function public.asn_relay_group_create(p_user uuid, p_node text, p_name text, p_ai text[] DEFAULT '{}'::text[], p_id text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_t uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_id text;
  k text;
begin
  if not public.asn_user_owns_node(p_user, p_node) then return jsonb_build_object('error', 'forbidden'); end if;
  v_t := relay.user_tenant(p_user);
  if v_t is null or char_length(v_name) not between 1 and 60 or coalesce(array_length(p_ai, 1), 0) > 20 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if relay.group_limit_hit(p_user, true) then return jsonb_build_object('error', 'room_limit'); end if;
  v_id := coalesce(p_id, relay.group_new_id());
  if v_id !~ '^[A-Za-z0-9_-]{1,32}$' then return jsonb_build_object('error', 'bad_request'); end if;
  if exists (select 1 from relay.rooms where id = v_id) then return jsonb_build_object('error', 'id_taken'); end if;
  foreach k in array coalesce(p_ai, array[]::text[]) loop
    if not relay.group_own_window(k, v_t) then return jsonb_build_object('error', 'bad_member', 'member', k); end if;
  end loop;
  insert into relay.rooms (id, name, created_by, tenant_id, created_by_user)
    values (v_id, v_name, '~u:' || p_user::text, v_t, p_user);
  insert into relay.room_pins (room_id) values (v_id);
  perform relay.group_add_human(v_id, p_user, 'owner', 'create', 0);
  foreach k in array coalesce(p_ai, array[]::text[]) loop
    perform relay.group_add_ai(v_id, k, p_user, 'manual', 0);
  end loop;
  return jsonb_build_object('id', v_id, 'name', v_name, 'bell_topics', to_jsonb(relay.room_bells(v_id)));
end;
$function$;

-- ===== 帶自己的 AI 進群組／移出 =====
create or replace function public.asn_relay_group_ai_add(p_user uuid, p_node text, p_room text, p_keys text[])
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path to ''
AS $function$
declare
  v_t uuid;
  v_hk text;
  k text;
  v_last bigint;
  v_n integer := 0;
  c record;
begin
  if not public.asn_user_owns_node(p_user, p_node) then return jsonb_build_object('error', 'forbidden'); end if;
  v_hk := relay.room_human_member(p_room, p_user);
  if v_hk is null then return jsonb_build_object('error', 'not_member'); end if;
  v_t := relay.user_tenant(p_user);
  if p_keys is null or coalesce(array_length(p_keys, 1), 0) not between 1 and 10 then return jsonb_build_object('error', 'bad_request'); end if;
  foreach k in array p_keys loop
    if not relay.group_own_window(k, v_t) then return jsonb_build_object('error', 'bad_member', 'member', k); end if;
  end loop;
  select last_seq into v_last from relay.rooms where id = p_room;
  foreach k in array p_keys loop
    if relay.room_is_member(p_room, k) then continue; end if;
    select * into c from relay.group_counts(p_room);
    if c.total >= c.cap then return jsonb_build_object('error', 'member_limit'); end if;
    perform relay.group_add_ai(p_room, k, p_user, 'manual', v_last);
    perform relay.group_system_msg(p_room, v_hk, relay.room_display_name(p_room, v_hk) || ' 把夥伴 ' || relay.room_display_name(p_room, k) || ' 帶進了群組。');
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('added', v_n, 'bell_topics', to_jsonb(relay.room_bells(p_room)));
end;
$function$;

create or replace function public.asn_relay_group_ai_remove(p_user uuid, p_node text, p_room text, p_key text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path to ''
AS $function$
declare v_hk text;
begin
  if not public.asn_user_owns_node(p_user, p_node) then return jsonb_build_object('error', 'forbidden'); end if;
  v_hk := relay.room_human_member(p_room, p_user);
  if v_hk is null then return jsonb_build_object('error', 'not_member'); end if;
  update relay.room_members m set left_at = now()
    where m.room_id = p_room and m.member = p_key and m.left_at is null and m.member !~ '^~'
      and relay.member_tenant(m.member, null) is not distinct from relay.user_tenant(p_user);
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end;
$function$;

-- 這個群組接不接受「別人」點名我的某個 AI（只有那個 AI 的主人能改）
create or replace function public.asn_relay_group_allow_others(p_user uuid, p_node text, p_room text, p_key text, p_allow boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path to ''
AS $function$
begin
  if not public.asn_user_owns_node(p_user, p_node) then return jsonb_build_object('error', 'forbidden'); end if;
  update relay.room_members m set allow_others = coalesce(p_allow, true)
    where m.room_id = p_room and m.member = p_key and m.left_at is null and m.member !~ '^~'
      and relay.member_tenant(m.member, null) is not distinct from relay.user_tenant(p_user);
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'allow', coalesce(p_allow, true));
end;
$function$;

-- ===== 退出 =====
create or replace function public.asn_relay_group_leave(p_user uuid, p_node text, p_room text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path to ''
AS $function$
declare
  v_hk text;
  v_t uuid := relay.user_tenant(p_user);
  v_name text;
begin
  if not public.asn_user_owns_node(p_user, p_node) then return jsonb_build_object('error', 'forbidden'); end if;
  v_hk := relay.room_human_member(p_room, p_user);
  if v_hk is null then return jsonb_build_object('error', 'not_member'); end if;
  if relay.room_host(p_room) = p_user then
    if exists (select 1 from relay.room_members m where m.room_id = p_room and m.left_at is null and m.member like '~u:%' and m.member <> v_hk) then
      return jsonb_build_object('error', 'host_must_transfer');
    end if;
    update relay.rooms set archived_at = now() where id = p_room;   -- 主持人是最後一位真人：群組封存
  end if;
  v_name := relay.room_display_name(p_room, v_hk);
  perform relay.group_system_msg(p_room, v_hk, v_name || ' 離開了群組。');
  update relay.room_members m set left_at = now()
    where m.room_id = p_room and m.left_at is null
      and (m.member = v_hk or (m.member !~ '^~' and relay.member_tenant(m.member, null) is not distinct from v_t));
  return jsonb_build_object('ok', true);
end;
$function$;

-- ===== 一對一升級（加我的另一個 AI）=====
create or replace function public.asn_relay_group_upgrade(p_user uuid, p_node text, p_src_node text, p_src_agent text, p_seed integer, p_name text, p_extra text[])
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path to ''
AS $function$
declare
  v_t uuid;
  k text;
  v_res jsonb;
begin
  if not public.asn_user_owns_node(p_user, p_node) then return jsonb_build_object('error', 'forbidden'); end if;
  v_t := relay.user_tenant(p_user);
  if v_t is null or p_src_node is null or coalesce(array_length(p_extra, 1), 0) not between 1 and 10 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not exists (select 1 from relay.nodes n where n.id = p_src_node and n.tenant_id = v_t and n.status = 'active')
     or (coalesce(p_src_agent, '') <> '' and not exists (select 1 from relay.roster r where r.node = p_src_node and r.name = p_src_agent)) then
    return jsonb_build_object('error', 'not_found');
  end if;
  foreach k in array p_extra loop
    if not relay.group_own_window(k, v_t) then return jsonb_build_object('error', 'bad_member', 'member', k); end if;
  end loop;
  if relay.group_limit_hit(p_user, true) then return jsonb_build_object('error', 'room_limit'); end if;
  v_res := relay.group_build_upgrade(p_user, p_src_node, p_src_agent, p_seed, p_name, p_extra);
  return v_res || jsonb_build_object('bell_topics', to_jsonb(relay.room_bells(v_res->>'id')));
end;
$function$;

-- ===== 邀請 =====
create or replace function public.asn_relay_group_invite_create(p_user uuid, p_node text, p_kind text, p_room text, p_src_node text, p_src_agent text, p_seed integer, p_code_hash text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path to ''
AS $function$
declare
  v_t uuid;
  v_id uuid;
  v_exp timestamptz;
  v_seed integer := least(greatest(coalesce(p_seed, 40), 0), 50);
  v_hk text;
begin
  if not public.asn_user_owns_node(p_user, p_node) then return jsonb_build_object('error', 'forbidden'); end if;
  v_t := relay.user_tenant(p_user);
  if v_t is null or p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' or p_kind not in ('conversation', 'room') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if (select count(*) from relay.person_invites i where i.created_by_user = p_user and i.created_at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  if p_kind = 'room' then
    v_hk := relay.room_human_member(p_room, p_user);
    if v_hk is null then return jsonb_build_object('error', 'not_member'); end if;
    if relay.room_host(p_room) is distinct from p_user
       and not exists (select 1 from relay.room_members m where m.room_id = p_room and m.member = v_hk and m.role in ('owner', 'admin')) then
      return jsonb_build_object('error', 'forbidden');
    end if;
    insert into relay.person_invites (code_hash, kind, room_id, created_by_user) values (p_code_hash, 'room', p_room, p_user)
      returning id, expires_at into v_id, v_exp;
    return jsonb_build_object('id', v_id, 'kind', 'room', 'expires_at', v_exp, 'uses', 1);
  end if;
  if p_src_node is null
     or not exists (select 1 from relay.nodes n where n.id = p_src_node and n.tenant_id = v_t and n.status = 'active')
     or (coalesce(p_src_agent, '') <> '' and not exists (select 1 from relay.roster r where r.node = p_src_node and r.name = p_src_agent)) then
    return jsonb_build_object('error', 'not_found');
  end if;
  insert into relay.person_invites (code_hash, kind, source_node, source_agent, seed_count, created_by_user)
    values (p_code_hash, 'conversation', p_src_node, nullif(p_src_agent, ''), v_seed, p_user)
    returning id, expires_at into v_id, v_exp;
  return jsonb_build_object('id', v_id, 'kind', 'conversation', 'expires_at', v_exp, 'seed_count', v_seed, 'uses', 1);
end;
$function$;

create or replace function public.asn_relay_group_invite_revoke(p_user uuid, p_node text, p_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path to ''
AS $function$
begin
  if not public.asn_user_owns_node(p_user, p_node) then return jsonb_build_object('error', 'forbidden'); end if;
  update relay.person_invites set revoked_at = now()
    where id = p_id and created_by_user = p_user and used_at is null and revoked_at is null;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end;
$function$;

-- 預覽：只回邀請人名字、群組名（或建議名）、開頭紀錄則數、到期時間；不回成員名單、代號、任何對話內容
create or replace function public.asn_relay_group_invite_preview(p_user uuid, p_node text, p_code_hash text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path to ''
AS $function$
declare
  i relay.person_invites%rowtype;
  v_inviter text;
begin
  if not public.asn_user_owns_node(p_user, p_node) then return jsonb_build_object('error', 'forbidden'); end if;
  if (select count(*) from relay.invite_attempts a where a.user_id = p_user and a.at > now() - interval '1 hour') >= 20 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  select * into i from relay.person_invites where code_hash = p_code_hash;
  if not found then
    insert into relay.invite_attempts (user_id) values (p_user);
    return jsonb_build_object('error', 'invalid_invite');
  end if;
  if i.revoked_at is not null then return jsonb_build_object('error', 'invite_revoked'); end if;
  if i.used_at is not null then return jsonb_build_object('error', 'invite_used'); end if;
  if i.expires_at <= now() then return jsonb_build_object('error', 'invite_expired'); end if;
  v_inviter := (select t.owner_name from relay.tenants t where t.owner_user = i.created_by_user);
  return jsonb_build_object('kind', i.kind, 'inviter_name', v_inviter, 'expires_at', i.expires_at,
    'room_name', case when i.kind = 'room' then (select r.name from relay.rooms r where r.id = i.room_id) end,
    'seed_count', case when i.kind = 'conversation' then i.seed_count end);
end;
$function$;

-- 接受邀請（一次性：用掉就失效）
create or replace function public.asn_relay_group_invite_accept(p_user uuid, p_node text, p_code_hash text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path to ''
AS $function$
declare
  i relay.person_invites%rowtype;
  v_room text;
  v_name text;
  v_last bigint;
  c record;
  v_res jsonb;
begin
  if not public.asn_user_owns_node(p_user, p_node) then return jsonb_build_object('error', 'forbidden'); end if;
  if relay.user_tenant(p_user) is null then return jsonb_build_object('error', 'no_account'); end if;
  if (select count(*) from relay.invite_attempts a where a.user_id = p_user and a.at > now() - interval '1 hour') >= 20 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  select * into i from relay.person_invites where code_hash = p_code_hash for update;
  if not found then
    insert into relay.invite_attempts (user_id) values (p_user);
    return jsonb_build_object('error', 'invalid_invite');
  end if;
  if i.revoked_at is not null then return jsonb_build_object('error', 'invite_revoked'); end if;
  if i.used_at is not null then return jsonb_build_object('error', 'invite_used'); end if;
  if i.expires_at <= now() then return jsonb_build_object('error', 'invite_expired'); end if;
  if i.created_by_user = p_user then return jsonb_build_object('error', 'own_invite'); end if;
  if relay.group_limit_hit(p_user, false) then return jsonb_build_object('error', 'room_limit'); end if;

  if i.kind = 'room' then
    if not exists (select 1 from relay.rooms r where r.id = i.room_id and r.archived_at is null) then
      return jsonb_build_object('error', 'invalid_invite');
    end if;
    if relay.room_human_member(i.room_id, p_user) is not null then return jsonb_build_object('error', 'already_member'); end if;
    select * into c from relay.group_counts(i.room_id);
    if c.total >= c.cap or c.humans >= 10 then return jsonb_build_object('error', 'member_limit'); end if;
    select last_seq into v_last from relay.rooms where id = i.room_id;
    perform relay.group_add_human(i.room_id, p_user, 'member', 'invite', v_last);   -- 一般加入：看不到加入前的訊息
    v_room := i.room_id;
  else
    if relay.group_limit_hit(i.created_by_user, true) then return jsonb_build_object('error', 'room_limit'); end if;
    v_res := relay.group_build_upgrade(i.created_by_user, i.source_node, i.source_agent, i.seed_count, null, null);
    v_room := v_res->>'id';
    perform relay.group_add_human(v_room, p_user, 'member', 'invite', 0);        -- 升級的新群組：從開頭紀錄第 1 則起可見
    select last_seq into v_last from relay.rooms where id = v_room;
    update relay.room_members set read_seq = v_last where room_id = v_room and member = '~u:' || p_user::text;
  end if;
  perform relay.group_system_msg(v_room, '~u:' || p_user::text, relay.room_display_name(v_room, '~u:' || p_user::text) || ' 加入了群組。');
  update relay.person_invites set used_at = now(), used_by_user = p_user, result_room = v_room where id = i.id;
  select name into v_name from relay.rooms where id = v_room;
  return jsonb_build_object('room_id', v_room, 'name', v_name, 'kind', i.kind, 'bell_topics', to_jsonb(relay.room_bells(v_room)));
end;
$function$;

-- 群組有沒有別的租戶的成員（有就不准傳附件）；只有成員節點問得到
create or replace function public.asn_relay_group_has_external(p_node text, p_room text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path to ''
AS $function$
  select exists (select 1 from relay.room_members m where m.room_id = p_room and m.left_at is null
                   and (m.member = p_node or left(m.member, char_length(p_node) + 1) = p_node || '~' or (m.member = '~owner' and relay.room_can(p_room, p_node, '~owner'))
                        or (m.member like '~u:%' and exists (select 1 from relay.nodes n where n.id = p_node and n.owner_user::text = substr(m.member, 4)))))
     and relay.room_has_external(p_room);
$function$;

-- ===== 危險操作：待主持人確認 =====
-- 危險操作（被別人點名的 AI 做這些之前必須在群組請主持人確認）：
--   data_change＝修改或刪除既有的資料（含既有檔案、資料庫、帳務）；deploy＝部署／上線／發版；spend＝花錢、付款、下單；
--   external_send＝對外寄送（郵件、訊息、發佈）；account_config＝動到主人的帳號或設定（憑證、權限、訂閱）；other＝其他不可回復的操作。
-- 調查、寫文件、新增產出（建立新檔案、草稿、報表）不在其內，可直接做。
create or replace function relay.confirm_kind_label(p_kind text)
 returns text language sql immutable set search_path to ''
as $function$
  select case p_kind
    when 'data_change' then '修改或刪除既有資料' when 'deploy' then '部署' when 'spend' then '花錢或付款'
    when 'external_send' then '對外寄送' when 'account_config' then '動到主人的帳號或設定' else '其他不可回復的操作' end;
$function$;

create or replace function public.asn_relay_group_confirm_request(p_node text, p_agent text, p_room text, p_kind text, p_summary text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path to ''
AS $function$
declare
  v_key text := relay.room_caller_key(p_node, p_agent, false);
  v_sum text := btrim(coalesce(p_summary, ''));
  v_host uuid;
  v_hk text;
  v_id uuid;
  v_rt uuid;
  v_seq bigint;
  v_ru uuid;
begin
  if v_key is null or position('~' in v_key) = 0 then return jsonb_build_object('error', 'forbidden'); end if;
  if not relay.room_can(p_room, p_node, v_key) then return jsonb_build_object('error', 'not_member'); end if;
  if p_kind is null or p_kind not in ('data_change', 'deploy', 'spend', 'external_send', 'account_config', 'other') then
    return jsonb_build_object('error', 'bad_kind');
  end if;
  if char_length(v_sum) not between 1 and 500 then return jsonb_build_object('error', 'bad_request'); end if;
  if (select count(*) from relay.room_confirms c where c.room_id = p_room and c.requester = v_key and c.status = 'pending' and c.expires_at > now()) >= 5 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  v_host := relay.room_host(p_room);
  v_hk := case when v_host is null then null else relay.room_human_member(p_room, v_host) end;
  if v_hk is null then return jsonb_build_object('error', 'no_host'); end if;
  select tenant_id into v_rt from relay.rooms where id = p_room;
  v_ru := (select t.owner_user from relay.tenants t where t.id = relay.member_tenant(v_key, v_rt));
  insert into relay.room_confirms (room_id, requester, requester_user, host_user, kind, summary)
    values (p_room, v_key, v_ru, v_host, p_kind, v_sum) returning id into v_id;
  v_seq := relay.room_append(p_room, v_key, 'member',
    '【待主持人確認 #' || substr(v_id::text, 1, 8) || '】' || relay.room_display_name(p_room, v_key)
      || '（' || coalesce(relay.room_owner_name(v_key, v_rt), '?') || '）要做危險操作（' || relay.confirm_kind_label(p_kind) || '）：'
      || v_sum || '。請主持人在群組回覆確認；確認前不會執行。',
    array[v_hk], 'ai', false, v_ru);
  update relay.room_confirms set request_seq = v_seq where id = v_id;
  return jsonb_build_object('id', v_id, 'short', substr(v_id::text, 1, 8), 'seq', v_seq, 'status', 'pending',
                            'bell_topics', to_jsonb(relay.room_bells(p_room)));
end;
$function$;

-- 主持人確認或拒絕（本人簽章）。只有該請求指定的主持人，且必須還在群組裡
create or replace function public.asn_relay_group_confirm_decide(p_user uuid, p_node text, p_room text, p_id uuid, p_approve boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path to ''
AS $function$
declare
  c relay.room_confirms%rowtype;
  v_hk text;
  v_seq bigint;
  v_short text;
begin
  if not public.asn_user_owns_node(p_user, p_node) then return jsonb_build_object('error', 'forbidden'); end if;
  select * into c from relay.room_confirms where id = p_id and room_id = p_room for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  v_hk := relay.room_human_member(p_room, p_user);
  if v_hk is null then return jsonb_build_object('error', 'not_member'); end if;
  if c.host_user <> p_user then return jsonb_build_object('error', 'forbidden'); end if;
  if c.status <> 'pending' then return jsonb_build_object('error', 'already_decided'); end if;
  if c.expires_at <= now() then return jsonb_build_object('error', 'expired'); end if;
  v_short := substr(c.id::text, 1, 8);
  update relay.room_confirms set status = case when p_approve then 'approved' else 'denied' end,
    decided_at = now(), decided_by_user = p_user, signed = true where id = c.id;
  v_seq := relay.room_append(p_room, v_hk, 'owner',
    case when p_approve then '【主持人已確認 #' || v_short || '】可以執行：' || c.summary
         else '【主持人已拒絕 #' || v_short || '】不要執行：' || c.summary end,
    array[c.requester], 'human', false, p_user);
  update relay.room_confirms set decision_seq = v_seq where id = c.id;
  return jsonb_build_object('id', c.id, 'status', case when p_approve then 'approved' else 'denied' end, 'seq', v_seq,
                            'bell_topics', to_jsonb(relay.room_bells(p_room)));
end;
$function$;

-- AI 查自己的請求有沒有放行；放行只能用一次（consume）
create or replace function public.asn_relay_group_confirm_status(p_node text, p_agent text, p_id uuid, p_consume boolean DEFAULT true)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path to ''
AS $function$
declare
  v_key text := relay.room_caller_key(p_node, p_agent, false);
  c relay.room_confirms%rowtype;
begin
  if v_key is null then return jsonb_build_object('error', 'forbidden'); end if;
  select * into c from relay.room_confirms where id = p_id and requester = v_key for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if c.status = 'denied' then return jsonb_build_object('status', 'denied'); end if;
  if c.consumed_at is not null then return jsonb_build_object('status', 'used'); end if;
  if c.expires_at <= now() then return jsonb_build_object('status', 'expired'); end if;
  if c.status = 'pending' then return jsonb_build_object('status', 'pending'); end if;
  if coalesce(p_consume, true) then
    update relay.room_confirms set consumed_at = now() where id = c.id;
    return jsonb_build_object('status', 'approved', 'consumed', true);
  end if;
  return jsonb_build_object('status', 'approved', 'consumed', false);
end;
$function$;

-- 群組內的人看確認紀錄（近 50 筆）
create or replace function public.asn_relay_group_confirm_list(p_user uuid, p_node text, p_room text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path to ''
AS $function$
declare v_rt uuid;
begin
  if not public.asn_user_owns_node(p_user, p_node) then return jsonb_build_object('error', 'forbidden'); end if;
  if relay.room_human_member(p_room, p_user) is null then return jsonb_build_object('error', 'not_member'); end if;
  select tenant_id into v_rt from relay.rooms where id = p_room;
  return jsonb_build_object('confirms', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'short', substr(c.id::text, 1, 8), 'kind', c.kind, 'kind_label', relay.confirm_kind_label(c.kind), 'summary', c.summary,
      'status', case when c.status = 'pending' and c.expires_at <= now() then 'expired' else c.status end,
      'requester_name', relay.room_display_name(p_room, c.requester),
      'requester_owner', relay.room_owner_name(c.requester, v_rt),
      'is_host', c.host_user = p_user,
      'created_at', c.created_at, 'decided_at', c.decided_at, 'signed', c.signed) order by c.created_at desc), '[]'::jsonb)
    from (select * from relay.room_confirms x where x.room_id = p_room order by x.created_at desc limit 50) c));
end;
$function$;

-- 授權：只給 service_role
do $do$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'asn\_relay\_group\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end
$do$;

commit;
