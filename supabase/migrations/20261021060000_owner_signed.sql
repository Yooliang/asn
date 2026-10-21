-- 本人簽章（issue #118）：在 ASN 視窗打的字，若寄件人用登入憑證證明「這個節點與它的租戶都是我的」，信標成 trust=owner。
-- 節點金鑰照舊必備；登入憑證由後端驗證後把使用者 id 傳進來，這裡再核對一次擁有關係（後端出錯也不會多給信任）。
-- 沒帶／不符＝照舊（member，或節點本身 role=owner 的原本規則），不擋寄送。AI 用 send.mjs、asn-cli 寄的不帶憑證，所以不受影響。
-- 先不套用：需要小良哥同意後再套（見 CLAUDE.md）。
begin;

-- 信件上記一個旗標；收信時 trust = 寄件節點 role=owner 或 這封信有本人簽章
alter table relay.messages add column if not exists owner_signed boolean not null default false;

-- 使用者是否同時擁有這個節點與它所屬租戶（兩邊都要是這個人）
create or replace function public.asn_user_owns_node(p_user uuid, p_node text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and exists (
    select 1
    from relay.nodes n
    join relay.tenants t on t.id = n.tenant_id
    where n.id = p_node
      and n.status = 'active'
      and n.owner_user = p_user
      and t.owner_user = p_user
  );
$$;

revoke all on function public.asn_user_owns_node(uuid, text) from public, anon, authenticated;
grant execute on function public.asn_user_owns_node(uuid, text) to service_role;

-- send：多一個選填參數 p_signed_user（舊呼叫端不帶，行為不變）。換簽章要先拿掉舊的七參數版本
drop function if exists public.irori_relay_send(text, text, text, text, text, uuid, boolean);

create or replace function public.irori_relay_send(
  p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid,
  p_expects_reply boolean default null::boolean, p_signed_user uuid default null::uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_topic text;
  v_id uuid;
  v_recent int;
  v_tenant uuid;
  v_to text := p_to_node;
  v_char text;
  v_signed boolean := public.asn_user_owns_node(p_signed_user, p_from_node);
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
  insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply, owner_signed)
    values (p_from_node, p_from_agent, v_to, p_to_agent, p_body, p_reply_to, v_tenant, p_expects_reply, v_signed)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

-- 收信：trust 多一個條件（本人簽章）
create or replace function public.irori_relay_inbox(p_node text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
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
      'trust', case when f.role = 'owner' or m.owner_signed then 'owner' else 'member' end) order by m.created_at, m.id), '[]'::jsonb)
    into v_out from relay.messages m join relay.nodes f on f.id = m.from_node where m.id = any(v_ids);
  return v_out;
end;
$function$;

create or replace function public.irori_relay_inbox_agent(p_node text, p_agent text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
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
      'trust', case when f.role = 'owner' or m.owner_signed then 'owner' else 'member' end) order by m.created_at, m.id), '[]'::jsonb)
    into v_out from relay.messages m join relay.nodes f on f.id = m.from_node where m.id = any(v_ids);
  return v_out;
end;
$function$;

-- 群組發言：同樣多 p_signed_user；有本人簽章就把這則訊息的 trust 記成 owner（成員 key 仍是節點／視窗，不冒充 ~owner）
drop function if exists public.irori_relay_room_post(text, text, text, text, text[], boolean);

create or replace function public.irori_relay_room_post(
  p_node text, p_agent text, p_room text, p_body text, p_mentions text[],
  p_owner boolean default false, p_signed_user uuid default null::uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
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
  v_trust := case when p_owner or relay.room_actor_is_owner(p_node) or public.asn_user_owns_node(p_signed_user, p_node)
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

revoke all on function public.irori_relay_send(text, text, text, text, text, uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function public.irori_relay_send(text, text, text, text, text, uuid, boolean, uuid) to service_role;
revoke all on function public.irori_relay_room_post(text, text, text, text, text[], boolean, uuid) from public, anon, authenticated;
grant execute on function public.irori_relay_room_post(text, text, text, text, text[], boolean, uuid) to service_role;

commit;
