-- 退回 23：irori_relay_send 還原成 16_tenants.sql 的 6 參數版、irori_relay_inbox／irori_relay_inbox_agent 還原成 01／08 的版本，
-- 最後拿掉 relay.messages.expects_reply 欄位（已經寫進去的值會一起消失）。整段在一個交易裡。
-- 要先把 irori-relay／irori-api 退回不帶 expects_reply 的舊版再跑；不然新版函式帶 p_expects_reply 呼叫會因為簽章不存在而失敗。
begin;

drop function if exists public.irori_relay_send(text, text, text, text, text, uuid, boolean);

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
  insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id)
    values (p_from_node, p_from_agent, v_to, p_to_agent, p_body, p_reply_to, v_tenant)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$$;

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

create or replace function public.irori_relay_inbox_agent(p_node text, p_agent text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
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
      'reply_to', m.reply_to, 'created_at', m.created_at,
      'trust', case when f.role = 'owner' then 'owner' else 'member' end) order by m.created_at, m.id), '[]'::jsonb)
    into v_out from relay.messages m join relay.nodes f on f.id = m.from_node where m.id = any(v_ids);
  return v_out;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.irori_relay_send(text,text,text,text,text,uuid)',
    'public.irori_relay_inbox(text)',
    'public.irori_relay_inbox_agent(text,text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

alter table relay.messages drop column if exists expects_reply;

commit;
