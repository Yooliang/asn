-- 退回 20261023170000～170200（真人好友與群組 第 1a 期後台）。
-- 先把群組讀寫函式換回上一版的定義（以租戶判斷存取、trust 取寫入值），再拿掉新函式、新表、新欄位。
-- 注意：拿掉欄位與表會丟失這一期產生的資料（跨租戶群組成員、邀請、確認紀錄、開頭紀錄的標記）；舊群組的資料不受影響。
-- 已有跨租戶成員的群組，退回後舊函式會因「群組不在呼叫者租戶」而讀不到——退回前先確認沒有需要保留的跨租戶群組。
begin;

-- 1. 群組讀寫函式換回舊定義（簽章不變）
create or replace function public.asn_relay_room_post(p_node text, p_agent text, p_room text, p_body text, p_mentions text[], p_owner boolean DEFAULT false, p_signed_user uuid DEFAULT NULL::uuid)
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
  v_trust := case when p_owner or public.asn_user_owns_node(p_signed_user, p_node)
                  then 'owner' else 'member' end;
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

CREATE OR REPLACE FUNCTION public.asn_relay_room_pin_get(p_node text, p_agent text, p_room text, p_owner boolean DEFAULT false)
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

CREATE OR REPLACE FUNCTION public.asn_relay_room_read(p_node text, p_agent text, p_room text, p_since bigint, p_limit integer, p_owner boolean DEFAULT false, p_tail boolean DEFAULT false, p_mark boolean DEFAULT NULL::boolean)
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

CREATE OR REPLACE FUNCTION public.asn_relay_room_list(p_node text, p_owner boolean DEFAULT false)
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

CREATE OR REPLACE FUNCTION public.asn_relay_room_members(p_node text, p_agent text, p_room text, p_owner boolean DEFAULT false)
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

-- 2. 拿掉新函式
do $do$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'asn\_relay\_group\_%') loop
    execute format('drop function %s', r.sig);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'relay' and p.proname in ('member_tenant', 'user_tenant', 'signed_user', 'room_actor_key', 'room_can', 'room_member_is_mine',
             'room_ext_key', 'room_resolve_key', 'room_display_name', 'room_owner_name', 'msg_kind', 'room_append', 'room_has_external', 'room_bells',
             'room_host', 'room_human_member', 'room_wake_filter', 'room_members_view', 'group_new_id', 'group_add_human', 'group_add_ai',
             'group_system_msg', 'group_own_window', 'group_counts', 'group_limit_hit', 'group_build_upgrade', 'confirm_kind_label') loop
    execute format('drop function %s', r.sig);
  end loop;
end
$do$;

-- 3. 拿掉新表與新欄位
drop table if exists relay.room_confirms;
drop table if exists relay.room_wakes;
drop table if exists relay.invite_attempts;
drop table if exists relay.person_invites;

-- 只有 ~u: 成員與新的加入方式、角色會讓舊的限制失敗：先刪掉這一期新增的列
delete from relay.room_messages where from_member like '~u:%' or from_kind is not null or is_seed;
delete from relay.room_members where member like '~u:%' or joined_via in ('create', 'invite', 'upgrade') or role = 'admin';
delete from relay.room_pins where room_id in (select id from relay.rooms where created_by_user is not null);
delete from relay.room_messages where room_id in (select id from relay.rooms where created_by_user is not null);
delete from relay.room_members where room_id in (select id from relay.rooms where created_by_user is not null);
delete from relay.rooms where created_by_user is not null;

alter table relay.room_messages drop constraint if exists room_messages_from_kind_check;
alter table relay.room_messages drop column if exists suppressed, drop column if exists is_seed, drop column if exists from_kind, drop column if exists from_user;
alter table relay.room_members drop constraint if exists room_members_role_check;
alter table relay.room_members add constraint room_members_role_check check (role = any (array['owner','member']));
alter table relay.room_members drop constraint if exists room_members_joined_via_check;
alter table relay.room_members add constraint room_members_joined_via_check check (joined_via = any (array['auto','manual']));
drop index if exists relay.room_members_ref_key;
alter table relay.room_members drop column if exists allow_others, drop column if exists visible_from_seq, drop column if exists display_name,
  drop column if exists user_id, drop column if exists member_ref;
alter table relay.rooms drop column if exists member_cap, drop column if exists origin, drop column if exists created_by_user;

commit;
