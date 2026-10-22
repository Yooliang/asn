-- 節點信箱行頭堵塞修正：irori_relay_inbox 每次只回最舊 50 封未 ack 的信、不分收件視窗。
-- 內建收發室對「寄給 ASN 自己視窗」的信不 ack（留給 ASN 畫面收），這類信一多（95 封），最舊 50 封全是它們，
-- 寄給其他成員的新信就永遠進不了這一頁。
-- 做法：多一個選填參數 p_exclude_agents text[]（預設 null＝不排除，舊呼叫行為與回傳欄位完全不變）；
-- 帶了就略過 to_agent 在清單裡的信（to_agent 為空的「沒指定收件人」信永遠保留）。其餘（欄位、排序、limit 50、delivered_at、授權）與
-- 20261022090000_owner_sender_display.sql 的 irori_relay_inbox 逐字相同。
-- 先把舊的單參數版本拿掉，免得同名兩個多載讓只帶 p_node 的呼叫「不唯一」。
-- 先不套用：部署由負責的 session 處理（先套本 migration，再部署 relay 函式）。
begin;

drop function if exists public.irori_relay_inbox(text);

create or replace function public.irori_relay_inbox(p_node text, p_exclude_agents text[] default null::text[])
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
      and (p_exclude_agents is null or m.to_agent is null or not (m.to_agent = any(p_exclude_agents)))
    order by m.created_at, m.id limit 50
  ) s;
  update relay.messages set delivered_at = now()
    where id = any(v_ids) and delivered_at is null;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'from_node', relay.person_view_node(m.tenant_id, m.from_node, m.from_agent, m.person_user), 'from_agent', m.from_agent,
      'to_node', m.to_node, 'to_agent', m.to_agent, 'body', m.body,
      'reply_to', m.reply_to, 'created_at', m.created_at, 'expects_reply', m.expects_reply,
      'fanout_id', m.fanout_id,
      'sender_display', case when m.owner_signed or m.person_user is not null
         then (select nullif(btrim(t.owner_name), '') from relay.tenants t where t.id = m.tenant_id) end,
      'sender_device', f.name,
      'sender_engine', case when f.machine = '雲端代理' then 'cloud'
         else (select r.engine from relay.roster r where r.node = m.from_node and r.name = m.from_agent) end,
      'trust', case when f.role = 'owner' or m.owner_signed then 'owner' else 'member' end) order by m.created_at, m.id), '[]'::jsonb)
    into v_out from relay.messages m join relay.nodes f on f.id = m.from_node where m.id = any(v_ids);
  return v_out;
end;
$function$;

revoke all on function public.irori_relay_inbox(text, text[]) from public, anon, authenticated;
grant execute on function public.irori_relay_inbox(text, text[]) to service_role;

commit;
