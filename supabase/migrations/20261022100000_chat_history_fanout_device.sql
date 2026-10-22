-- 多設備 #108 兩個修正（asn_chat_history）：
--  1. 同一個 fanout_id 只回一列（真機實測：AI 回信扇出成每台設備一列，補 90 天往來時一個震動顯示三次）。
--     這一列優先用「呼叫端節點自己的那份」，沒有就用最早的一份；回傳多帶 fanout_id（沒有扇出＝null），ids 仍含所有複本。
--  2. 每則多帶寄出節點：from_node（節點 id）與 from_node_name（設備名），讓前端在「自己寄的信、寄出設備不是目前這台」時標「從 Oppo 手機」。
-- 參數與回傳外形與上一版相同（只多欄位），舊的 Edge Function、舊版 ASN 不受影響。先不套用：部署由負責的 session 處理。
begin;

create or replace function public.asn_chat_history(p_user uuid, p_node text, p_partner_node text, p_partner_agent text, p_limit integer default 100, p_partner_id text default null::text)
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

revoke all on function public.asn_chat_history(uuid, text, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.asn_chat_history(uuid, text, text, text, integer, text) to service_role;

commit;
