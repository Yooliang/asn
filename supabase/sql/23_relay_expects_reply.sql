-- 23_relay_expects_reply.sql：信件多一個「寄件人要不要等回信」的欄位 expects_reply（小良哥 10/05）。
-- 為什麼：收發室過去靠內文有沒有「（不需回覆）」猜要不要計時、跳「沒有收到回覆」，內文沒辦法用程式可靠判斷，
--   常把只是告知的信誤報成沒回。改成寄件人寄信時明說（send.mjs 的 --reply／--no-reply、代寄的 reply=yes|no），收發室看欄位決定。
-- 欄位：relay.messages.expects_reply boolean，可為 null。true＝寄件人在等回信、false＝只是告知；null＝舊信（舊版寄件工具）不知道，
--   收發室遇到 null 才退回看內文標記（過渡期相容）。不回填舊信。
-- 函式（只多一個欄位，其他行為一字不改——本體逐字取自原本的版本，tests/relay_expects_reply_sql.test.mjs 逐字比對）：
--   1. irori_relay_send：多收選填參數 p_expects_reply（預設 null，所以還沒更新的 irori-relay／irori-api 照舊用 6 個參數呼叫也行）並寫進去。
--      簽章變了，create or replace 會多出一個多載、和舊的 6 參數版一起存在時呼叫會有歧義，所以先 drop 舊簽章再建新的（本體取自 16_tenants.sql）。
--   2. irori_relay_inbox（本體取自 01_relay.sql）、irori_relay_inbox_agent（取自 08_agent_inbox.sql）：回傳的每封信多一個 expects_reply（null 就是 null）。
-- 執行方式：npx supabase db query --linked -f supabase/sql/23_relay_expects_reply.sql（可重複執行；只加欄位、換函式，不動任何資料）
-- 部署順序：【先】跑這支 SQL，【再】部署 irori-relay／irori-api 兩個函式。SQL 先上線時舊函式照常運作（只是還沒有欄位可寫）；
--   反過來（函式先上、SQL 還沒跑）時，帶 expects_reply 的寄信會因為資料庫函式簽章對不上而失敗。
-- 回復：supabase/sql/rollback/23_relay_expects_reply_down.sql（要先把 irori-relay／irori-api 退回舊版再跑）。
-- 權限：新建的函式 revoke 掉 public／anon／authenticated，只授權 service_role（和 01～21 一致）。
begin;

alter table relay.messages add column if not exists expects_reply boolean;

drop function if exists public.irori_relay_send(text, text, text, text, text, uuid);

create or replace function public.irori_relay_send(
  p_from_node text, p_from_agent text, p_to_node text, p_to_agent text,
  p_body text, p_reply_to uuid, p_expects_reply boolean default null
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
  insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply)
    values (p_from_node, p_from_agent, v_to, p_to_agent, p_body, p_reply_to, v_tenant, p_expects_reply)
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
      'reply_to', m.reply_to, 'created_at', m.created_at, 'expects_reply', m.expects_reply,
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
      'reply_to', m.reply_to, 'created_at', m.created_at, 'expects_reply', m.expects_reply,
      'trust', case when f.role = 'owner' then 'owner' else 'member' end) order by m.created_at, m.id), '[]'::jsonb)
    into v_out from relay.messages m join relay.nodes f on f.id = m.from_node where m.id = any(v_ids);
  return v_out;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.irori_relay_send(text,text,text,text,text,uuid,boolean)',
    'public.irori_relay_inbox(text)',
    'public.irori_relay_inbox_agent(text,text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;
