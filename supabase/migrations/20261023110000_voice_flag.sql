-- 語音通話標記：通話中寄出的信（內文是語音辨識的文字，可能有錯字）帶一個結構化欄位 voice，由收發室在收信端的抬頭說明行加固定提醒。
-- 為什麼是欄位不是內文文字：內文可以被任何寄件人偽造；欄位由寄件端的 ASN 經 Edge Function 送進來，收信端的橋只認布林 true。
-- 做法（刻意不重寫又長又常改的寄信函式 asn_relay_send）：
--  1. relay.messages 多一個 voice 欄位（預設 false；舊信、舊寄件工具都是 false）。
--  2. 新函式 asn_relay_send_voice：同一個交易內呼叫 asn_relay_send、成功後把該信標成 voice＝true（沒有「已寄出但還沒標記」的空檔，收信端不會先收到未標記的信）。
--  3. asn_relay_inbox、asn_relay_inbox_agent 多回一個欄位 voice（其餘欄位、排序、limit、授權與 20261023050000 逐字相同）；舊 irori_relay_* 包裝照舊轉呼叫。
-- 相容：舊後台沒有 asn_relay_send_voice，Edge Function 會退回一般寄信（信照寄、只是沒有標記）；舊橋看到多出來的 voice 欄位直接忽略。
-- 部署順序：先套本 migration，再部署 relay 函式，最後發新版 ASN。可重跑。
-- 回復：drop function public.asn_relay_send_voice(...)；inbox 兩支換回 20261023050000 的定義；alter table relay.messages drop column voice（欄位只是標記，留著也無害）。
begin;

alter table relay.messages add column if not exists voice boolean not null default false;

create or replace function public.asn_relay_send_voice(
  p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid,
  p_expects_reply boolean default null::boolean, p_signed_user uuid default null::uuid,
  p_as_person boolean default false, p_voice boolean default true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_r jsonb;
begin
  v_r := public.asn_relay_send(p_from_node, p_from_agent, p_to_node, p_to_agent, p_body, p_reply_to,
                               p_expects_reply, p_signed_user, p_as_person);
  if p_voice is true and v_r ? 'id' and not (v_r ? 'error') then
    update relay.messages set voice = true
      where id = (v_r ->> 'id')::uuid and from_node = p_from_node;
  end if;
  return v_r;
end;
$function$;

revoke all on function public.asn_relay_send_voice(text, text, text, text, text, uuid, boolean, uuid, boolean, boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_send_voice(text, text, text, text, text, uuid, boolean, uuid, boolean, boolean) to service_role;

create or replace function public.asn_relay_inbox(p_node text, p_exclude_agents text[] DEFAULT NULL::text[])
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
      and (p_exclude_agents is null or m.to_agent is null or not (m.to_agent = any(p_exclude_agents)))
    order by m.created_at, m.id limit 50
  ) s;
  update relay.messages set delivered_at = now()
    where id = any(v_ids) and delivered_at is null;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'from_node', relay.person_view_node(m.tenant_id, m.from_node, m.from_agent, m.person_user), 'from_agent', m.from_agent,
      'to_node', m.to_node, 'to_agent', m.to_agent, 'body', m.body,
      'reply_to', m.reply_to, 'created_at', m.created_at, 'expects_reply', m.expects_reply,
      'fanout_id', m.fanout_id, 'voice', m.voice,
      'sender_display', case when m.owner_signed or m.person_user is not null
         then (select nullif(btrim(t.owner_name), '') from relay.tenants t where t.id = m.tenant_id) end,
      'sender_device', f.name,
      'sender_engine', case when f.machine = '雲端代理' then 'cloud'
         else (select r.engine from relay.roster r where r.node = m.from_node and r.name = m.from_agent) end,
      'trust', case when m.owner_signed then 'owner' else 'member' end) order by m.created_at, m.id), '[]'::jsonb)
    into v_out from relay.messages m join relay.nodes f on f.id = m.from_node where m.id = any(v_ids);
  return v_out;
end;
$function$;

create or replace function public.asn_relay_inbox_agent(p_node text, p_agent text)
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
      'id', m.id, 'from_node', relay.person_view_node(m.tenant_id, m.from_node, m.from_agent, m.person_user), 'from_agent', m.from_agent,
      'to_node', m.to_node, 'to_agent', m.to_agent, 'body', m.body,
      'reply_to', m.reply_to, 'created_at', m.created_at, 'expects_reply', m.expects_reply,
      'fanout_id', m.fanout_id, 'voice', m.voice,
      'sender_display', case when m.owner_signed or m.person_user is not null
         then (select nullif(btrim(t.owner_name), '') from relay.tenants t where t.id = m.tenant_id) end,
      'sender_device', f.name,
      'sender_engine', case when f.machine = '雲端代理' then 'cloud'
         else (select r.engine from relay.roster r where r.node = m.from_node and r.name = m.from_agent) end,
      'trust', case when m.owner_signed then 'owner' else 'member' end) order by m.created_at, m.id), '[]'::jsonb)
    into v_out from relay.messages m join relay.nodes f on f.id = m.from_node where m.id = any(v_ids);
  return v_out;
end;
$function$;

commit;
