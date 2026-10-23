-- 往來記錄往上捲載入更舊的信：asn_chat_history 多一個選填的 p_before（timestamptz，預設 null＝行為與上一版完全相同）。
-- 帶了就只回 created_at 早於它的最近 p_limit 則（仍受 90 天與上限 200 限制）。其餘定義以 20261022100000 為底，一個字不動。
-- 舊的六參數版本先 drop，否則與七參數版本並存會「函式不唯一」（比照加 p_partner_id 的做法）。
-- 先不套用：部署由負責的 session 處理。順序：先套用這個 migration，再部署 Edge Function（反過來：帶 before 時 404，前端靜默停止往上載入，其餘照舊）。
begin;

drop function if exists public.asn_chat_history(uuid, text, text, text, integer, text);


create or replace function public.asn_chat_history(p_user uuid, p_node text, p_partner_node text, p_partner_agent text, p_limit integer default 100, p_partner_id text default null::text, p_before timestamptz default null)
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
  v_pid text := null;
  v_out jsonb;
begin
  if not public.asn_user_owns_node(p_user, p_node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_partner_node is null or p_partner_node !~ '^[A-Za-z0-9_-]{1,32}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select tenant_id into v_tenant from relay.nodes where id = p_node;
  -- 夥伴 ID 只認同租戶的；不是就當沒帶（只用名字比對）
  if p_partner_id is not null and exists (select 1 from relay.partners p where p.partner_id = p_partner_id and p.tenant_id = v_tenant) then
    v_pid := p_partner_id;
  end if;
  select coalesce(jsonb_agg(x.j order by x.at, x.gid), '[]'::jsonb) into v_out from (
    select g.gid, g.at, jsonb_build_object(
        'id', g.own_id, 'fanout_id', g.fanout_id, 'ids', g.ids, 'dir', g.dir, 'body', g.body, 'reply_to', g.reply_to,
        'created_at', g.at, 'delivered_at', g.delivered_at, 'acked_at', g.acked_at,
        'from_node', g.from_node,
        'from_node_name', (select nd.name from relay.nodes nd where nd.id = g.from_node and nd.tenant_id = v_tenant)) as j
    from (
      select coalesce(m.fanout_id, m.id) as gid,
             m.fanout_id as fanout_id,
             -- 同一個 fanout_id 只留一列：呼叫端自己那份優先，沒有就取最早的
             (array_agg(m.id order by coalesce(m.to_node = p_node, false) desc, m.created_at, m.id))[1] as own_id,
             array_agg(m.id order by m.created_at, m.id) as ids,
             case when bool_or(m.from_agent = v_alias) then 'me' else 'them' end as dir,
             min(m.created_at) as at,
             (array_agg(m.body order by m.created_at, m.id))[1] as body,
             (array_agg(m.reply_to order by m.created_at, m.id))[1] as reply_to,
             min(m.delivered_at) as delivered_at,
             min(m.acked_at) as acked_at,
             (array_agg(m.from_node order by m.created_at, m.id))[1] as from_node
      from relay.messages m
      where m.tenant_id = v_tenant
        and m.person_user = p_user
        and m.created_at > now() - interval '90 days'
        and (p_before is null or m.created_at < p_before)
        and (
          (m.from_agent = v_alias and m.to_node = p_partner_node and coalesce(m.to_agent, '') = coalesce(p_partner_agent, ''))
          or (m.from_agent is distinct from v_alias and m.from_node = p_partner_node and coalesce(m.from_agent, '') = coalesce(p_partner_agent, ''))
          or (v_pid is not null and m.from_agent = v_alias and m.to_partner_id = v_pid)
          or (v_pid is not null and m.from_agent is distinct from v_alias and m.from_partner_id = v_pid)
        )
      group by coalesce(m.fanout_id, m.id), m.fanout_id
      order by min(m.created_at) desc, coalesce(m.fanout_id, m.id)
      limit v_limit
    ) g
  ) x;
  return jsonb_build_object('messages', v_out);
end;
$function$;

revoke all on function public.asn_chat_history(uuid, text, text, text, integer, text, timestamptz) from public, anon, authenticated;
grant execute on function public.asn_chat_history(uuid, text, text, text, integer, text, timestamptz) to service_role;

commit;
