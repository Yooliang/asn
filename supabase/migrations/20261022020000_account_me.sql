-- 多設備對話連貫（issue #108）：以帳號而非設備為「我」。設計見 docs/design/ACCOUNT-ME.md。
--  1. 每個帳號一個「人」代號（u:十二位十六進位，由使用者 id 雜湊而來，不是使用者 id 本身）。
--  2. 本人簽章的信若明說 as_person（新版 ASN 才會說），寄件視窗名換成人代號、信上記 person_user。
--  3. 寄給「人代號」的信（AI 回信）扇出：此帳號每個在線的 ASN 視窗各得一列（各自 ack），列間以 fanout_id 相連。
--  4. 收信時，本人寄來的信對 AI 顯示的 from_node 一律是租戶的擁有者節點（不論從哪台設備寄的），AI 看到同一個人。
--  5. asn_chat_history：「我和某夥伴」90 天內的往來，以後台為準（本機只當快取）。
-- 相容：沒說 as_person、沒簽章、舊 Edge Function 呼叫（少一個參數）的行為與上一版完全相同；新欄位全部可空。
-- 先不套用：部署由負責的 session 處理。
begin;

alter table relay.messages
  add column if not exists person_user uuid,
  add column if not exists fanout_id uuid;
-- 往來查詢（帳號＋時間）；只有人相關的信才進索引
create index if not exists messages_person_idx on relay.messages (person_user, created_at) where person_user is not null;
create index if not exists messages_fanout_idx on relay.messages (fanout_id) where fanout_id is not null;

-- 人代號：不可逆（含固定字首的雜湊），只用來當信上的寄件／收件視窗名
create or replace function public.asn_person_alias(p_user uuid)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select case when p_user is null then null else 'u:' || substr(md5('asn-person:' || p_user::text), 1, 12) end;
$$;
revoke all on function public.asn_person_alias(uuid) from public, anon, authenticated;
grant execute on function public.asn_person_alias(uuid) to service_role;

-- 寄信：多一個選填參數 p_as_person（舊呼叫端不帶，行為不變）。換簽章要先拿掉舊的八參數版本
drop function if exists public.irori_relay_send(text, text, text, text, text, uuid, boolean, uuid);

create or replace function public.irori_relay_send(
  p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid,
  p_expects_reply boolean default null::boolean, p_signed_user uuid default null::uuid,
  p_as_person boolean default false)
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
  v_owner uuid;
  v_alias text;
  v_person boolean := false;
  v_from_agent text := p_from_agent;
  v_person_user uuid := null;
  v_targets jsonb;
  v_t jsonb;
  v_bells text[] := array[]::text[];
  v_head uuid;
  v_n int := 0;
begin
  if p_body is null or char_length(p_body) < 1 or char_length(p_body) > 20000 then
    return jsonb_build_object('error', 'bad_body');
  end if;
  select tenant_id into v_tenant from relay.nodes where id = p_from_node;
  select owner_user into v_owner from relay.tenants where id = v_tenant;
  v_alias := public.asn_person_alias(v_owner);
  if v_to = 'XISU' then
    select character_node into v_char from relay.tenants where id = v_tenant;
    if v_char is not null then v_to := v_char; end if;
  end if;

  -- 以「人」寄出：要有效的本人簽章、簽章的人就是租戶擁有者；收件人若是同帳號的 ASN 視窗（設備互聊）仍用原本的視窗名
  if coalesce(p_as_person, false) and v_signed and v_owner is not null and p_signed_user = v_owner
     and p_to_agent is distinct from v_alias
     and not exists (select 1 from relay.asn_presence ap where ap.node = v_to and ap.window_name = p_to_agent) then
    v_person := true;
    v_from_agent := v_alias;
    v_person_user := v_owner;
  end if;

  select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
    where from_node = p_from_node and created_at > now() - interval '1 minute';

  if p_reply_to is not null and not exists (
    select 1 from relay.messages where id = p_reply_to and tenant_id is not distinct from v_tenant
  ) then
    p_reply_to := null;
  end if;

  -- 寄給人代號（AI 回信）：扇出給此帳號每個在線的 ASN 視窗
  if not v_person and v_owner is not null and p_to_agent = v_alias then
    if v_recent >= 30 then
      return jsonb_build_object('error', 'rate_limited');
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('node', t.node, 'agent', t.window_name, 'bell', t.bell_topic)
             order by t.is_first desc, t.updated_at desc, t.node, t.window_name), '[]'::jsonb)
      into v_targets
      from (
        select p.node, p.window_name, n.bell_topic, p.updated_at, (p.node = v_to) as is_first
        from relay.asn_presence p join relay.nodes n on n.id = p.node
        where n.tenant_id = v_tenant and n.status = 'active' and n.owner_user = v_owner
          and p.updated_at > now() - interval '3 minutes'
        order by (p.node = v_to) desc, p.updated_at desc, p.node, p.window_name
        limit 10
      ) t;
    if jsonb_array_length(v_targets) = 0 then
      -- 沒有在線的 ASN：留一列（原收件節點；它不在了就挑帳號名下最早的節點），人打開 ASN 時從往來記錄補看
      select n.bell_topic, n.id into v_topic, v_to
        from relay.nodes n
        where n.tenant_id = v_tenant and n.status = 'active'
          and (n.id = v_to or n.owner_user = v_owner)
        order by (n.id = v_to) desc, n.created_at limit 1;
      if v_topic is null then
        return jsonb_build_object('error', 'unknown_to_node');
      end if;
      insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply, owner_signed, person_user)
        values (p_from_node, v_from_agent, v_to, p_to_agent, p_body, p_reply_to, v_tenant, p_expects_reply, v_signed, v_owner)
        returning id into v_id;
      return jsonb_build_object('id', v_id, 'bell_topic', v_topic, 'bell_topics', jsonb_build_array(v_topic), 'fanout', 0);
    end if;
    for v_t in select value from jsonb_array_elements(v_targets) loop
      insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply, owner_signed, person_user, fanout_id)
        values (p_from_node, v_from_agent, v_t->>'node', v_t->>'agent', p_body, p_reply_to, v_tenant, p_expects_reply, v_signed, v_owner, v_head)
        returning id into v_id;
      if v_head is null then
        v_head := v_id;
        update relay.messages set fanout_id = v_head where id = v_head;
      end if;
      v_n := v_n + 1;
      if not (v_t->>'bell' = any(v_bells)) then v_bells := v_bells || (v_t->>'bell'); end if;
    end loop;
    return jsonb_build_object('id', v_head, 'bell_topic', v_bells[1], 'bell_topics', to_jsonb(v_bells), 'fanout', v_n);
  end if;

  -- 一般寄信（與上一版相同；人寄出時多記 person_user、換寄件視窗名）
  select bell_topic into v_topic from relay.nodes
    where id = v_to and status = 'active' and tenant_id is not distinct from v_tenant;
  if v_topic is null then
    return jsonb_build_object('error', 'unknown_to_node');
  end if;
  if v_recent >= 30 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply, owner_signed, person_user)
    values (p_from_node, v_from_agent, v_to, p_to_agent, p_body, p_reply_to, v_tenant, p_expects_reply, v_signed, v_person_user)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

revoke all on function public.irori_relay_send(text, text, text, text, text, uuid, boolean, uuid, boolean) from public, anon, authenticated;
grant execute on function public.irori_relay_send(text, text, text, text, text, uuid, boolean, uuid, boolean) to service_role;

-- 收信：多帶 fanout_id；本人寄來的信，from_node 對收信的 AI 一律顯示租戶擁有者節點（同一個人不因設備不同而變）
create or replace function relay.person_view_node(p_tenant uuid, p_from_node text, p_from_agent text, p_person uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_person is not null and p_from_agent = public.asn_person_alias(p_person)
      then coalesce((select o.id from relay.nodes o where o.tenant_id = p_tenant and o.role = 'owner' and o.status = 'active' limit 1), p_from_node)
    else p_from_node end;
$$;
revoke all on function relay.person_view_node(uuid, text, text, uuid) from public, anon, authenticated;

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
      'id', m.id, 'from_node', relay.person_view_node(m.tenant_id, m.from_node, m.from_agent, m.person_user), 'from_agent', m.from_agent,
      'to_node', m.to_node, 'to_agent', m.to_agent, 'body', m.body,
      'reply_to', m.reply_to, 'created_at', m.created_at, 'expects_reply', m.expects_reply,
      'fanout_id', m.fanout_id,
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
      'id', m.id, 'from_node', relay.person_view_node(m.tenant_id, m.from_node, m.from_agent, m.person_user), 'from_agent', m.from_agent,
      'to_node', m.to_node, 'to_agent', m.to_agent, 'body', m.body,
      'reply_to', m.reply_to, 'created_at', m.created_at, 'expects_reply', m.expects_reply,
      'fanout_id', m.fanout_id,
      'trust', case when f.role = 'owner' or m.owner_signed then 'owner' else 'member' end) order by m.created_at, m.id), '[]'::jsonb)
    into v_out from relay.messages m join relay.nodes f on f.id = m.from_node where m.id = any(v_ids);
  return v_out;
end;
$function$;

-- 往來記錄：「我（這個帳號）和某夥伴」90 天內的信，兩個方向合併，扇出的複本只留一則（id＝群組代表 id，ids＝所有複本的 id，
-- 讓舊的本機快取也對得上）。最多 limit 則（預設 100、上限 200），由舊到新。呼叫者必須是這個帳號名下的節點（擁有關係由簽章再核對）。
create or replace function public.asn_chat_history(p_user uuid, p_node text, p_partner_node text, p_partner_agent text, p_limit integer default 100)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_tenant uuid;
  v_alias text := public.asn_person_alias(p_user);
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_out jsonb;
begin
  if not public.asn_user_owns_node(p_user, p_node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_partner_node is null or p_partner_node !~ '^[A-Za-z0-9_-]{1,32}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select tenant_id into v_tenant from relay.nodes where id = p_node;
  select coalesce(jsonb_agg(x.j order by x.at, x.gid), '[]'::jsonb) into v_out from (
    select g.gid, g.at, jsonb_build_object(
        'id', g.gid, 'ids', g.ids, 'dir', g.dir, 'body', g.body, 'reply_to', g.reply_to,
        'created_at', g.at, 'delivered_at', g.delivered_at, 'acked_at', g.acked_at) as j
    from (
      select coalesce(m.fanout_id, m.id) as gid,
             (array_agg(m.id order by m.created_at, m.id))[1] as head,
             array_agg(m.id order by m.created_at, m.id) as ids,
             case when bool_or(m.from_agent = v_alias) then 'me' else 'them' end as dir,
             min(m.created_at) as at,
             (array_agg(m.body order by m.created_at, m.id))[1] as body,
             (array_agg(m.reply_to order by m.created_at, m.id))[1] as reply_to,
             min(m.delivered_at) as delivered_at,
             min(m.acked_at) as acked_at
      from relay.messages m
      where m.tenant_id = v_tenant
        and m.person_user = p_user
        and m.created_at > now() - interval '90 days'
        and (
          (m.from_agent = v_alias and m.to_node = p_partner_node and coalesce(m.to_agent, '') = coalesce(p_partner_agent, ''))
          or (m.from_agent is distinct from v_alias and m.from_node = p_partner_node and coalesce(m.from_agent, '') = coalesce(p_partner_agent, ''))
        )
      group by coalesce(m.fanout_id, m.id)
      order by min(m.created_at) desc, coalesce(m.fanout_id, m.id)
      limit v_limit
    ) g
  ) x;
  return jsonb_build_object('messages', v_out);
end;
$function$;

revoke all on function public.asn_chat_history(uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.asn_chat_history(uuid, text, text, text, integer) to service_role;

-- 附件跟著扇出走：複本的附件綁在群組代表那一列，各複本查附件時對回代表列（回傳的 message_id 仍是被問的那一列）
create or replace function public.irori_relay_attach_for(p_message_ids uuid[], p_room text, p_seqs bigint[])
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
      'message_id', q.message_id, 'room_seq', q.room_seq, 'id', a.id, 'kind', a.kind, 'name', a.name,
      'mime', a.mime, 'bytes', a.bytes, 'width', a.width, 'height', a.height,
      'thumb', case when a.status = 'expired' or a.expires_at <= now() or a.removed_at is not null then null else a.thumb end,
      'expires_at', a.expires_at,
      'expired', (a.status = 'expired' or a.expires_at <= now() or a.removed_at is not null)
    ) order by a.created_at, a.id), '[]'::jsonb)
  from (
    select m.id as message_id, null::bigint as room_seq, a2.id as aid
    from relay.messages m join relay.attachments a2 on a2.message_id = coalesce(m.fanout_id, m.id)
    where m.id = any(coalesce(p_message_ids, array[]::uuid[]))
    union all
    select null::uuid, a3.room_seq, a3.id
    from relay.attachments a3
    where p_room is not null and a3.room_id = p_room and a3.room_seq = any(coalesce(p_seqs, array[]::bigint[]))
  ) q
  join relay.attachments a on a.id = q.aid
  where a.status in ('ready', 'expired');
$function$;

-- 換下載：多一條——信上記著 person_user 的，這個帳號名下的節點都可以（另一台設備看同一段往來）
create or replace function public.irori_relay_attach_access(p_node text, p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  a relay.attachments%rowtype;
  v_t uuid := relay.node_tenant(p_node);
  v_ok boolean := false;
begin
  select * into a from relay.attachments where id = p_id and tenant_id is not distinct from v_t and status <> 'pending';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if a.owner_node = p_node then
    v_ok := true;
  elsif a.message_id is not null then
    v_ok := exists (
      select 1 from relay.messages m
      where m.id = a.message_id
        and (m.to_node = p_node
          or (m.fanout_id is not null and exists (select 1 from relay.messages c where c.fanout_id = m.fanout_id and c.to_node = p_node))
          or (m.person_user is not null and exists (select 1 from relay.nodes pn where pn.id = p_node and pn.owner_user = m.person_user))));
  elsif a.room_id is not null then
    v_ok := exists (select 1 from relay.room_members rm
      where rm.room_id = a.room_id and rm.left_at is null and split_part(rm.member, '~', 1) = p_node);
  end if;
  if not v_ok then
    return jsonb_build_object('error', 'not_found');
  end if;
  if a.status = 'expired' or a.expires_at <= now() or a.removed_at is not null then
    return jsonb_build_object('error', 'expired');
  end if;
  return jsonb_build_object('path', a.storage_path, 'name', a.name, 'mime', a.mime, 'bytes', a.bytes);
end;
$function$;

commit;
