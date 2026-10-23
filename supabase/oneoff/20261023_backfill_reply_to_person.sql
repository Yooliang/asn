-- 一次性補送（請先審，未執行）：把卡在角色節點、沒指定視窗、未 ack、最近 7 天的信，補扇出給本人。
-- 條件：to_node 是租戶的角色節點（tenants.character_node 或 role='owner' 的節點）、to_agent 為 null、acked_at 為 null、
--      created_at 在 7 天內、寄件節點不是它自己。唯讀查詢目前命中 3 封：
--      a507b0ed-fe2c-42bf-9f22-4f3ee02415ec（w02 小職，10-22 07:58）、745f2b40-3930-4afb-8e73-30b0f1765e80、00f964d6-08d7-429a-bbae-05fb20270efa（w02 PCS，10-23 05:21）。
-- 做法：沿用寄信函式的離線行為——有在線 ASN（3 分鐘內有回報）就每個視窗一列（fanout_id 相連、記 person_user），
--      都沒有就留一列在本人名下最早的設備節點、視窗＝人代號（人打開 ASN 從往來記錄補看）；原信標成已 ack（不重複送）。
-- 不碰內文的輸出；原列不刪、只改 acked_at。要還原：把原信 acked_at 設回 null、刪掉 fanout_id 為新列的副本（以 created 時間與 person_user 辨認）。
begin;

do $$
declare
  v_m record;
  v_t record;
  v_owner uuid;
  v_alias text;
  v_first text;
  v_head uuid;
  v_id uuid;
  v_n int;
  v_done int := 0;
begin
  for v_m in
    select m.* from relay.messages m
    join relay.tenants t on t.id = m.tenant_id
    where m.acked_at is null and m.created_at > now() - interval '7 days'
      and m.to_agent is null and m.from_node <> m.to_node
      and (m.to_node = t.character_node
           or m.to_node in (select o.id from relay.nodes o where o.tenant_id = t.id and o.role = 'owner'))
    order by m.created_at, m.id
  loop
    select owner_user into v_owner from relay.tenants where id = v_m.tenant_id;
    v_alias := public.asn_person_alias(v_owner);
    continue when v_owner is null or v_alias is null;
    v_head := null; v_n := 0;
    for v_t in
      select p.node, p.window_name from relay.asn_presence p join relay.nodes n on n.id = p.node
      where n.tenant_id = v_m.tenant_id and n.status = 'active' and n.owner_user = v_owner and n.id <> v_m.to_node
        and p.updated_at > now() - interval '3 minutes'
      order by p.updated_at desc, p.node, p.window_name limit 10
    loop
      insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, created_at, tenant_id, expects_reply, owner_signed, person_user, fanout_id)
        values (v_m.from_node, v_m.from_agent, v_t.node, v_t.window_name, v_m.body, v_m.reply_to, v_m.created_at, v_m.tenant_id,
                v_m.expects_reply, v_m.owner_signed, v_owner, v_head)
        returning id into v_id;
      if v_head is null then
        v_head := v_id;
        update relay.messages set fanout_id = v_head where id = v_head;
      end if;
      v_n := v_n + 1;
    end loop;
    if v_n = 0 then
      select n.id into v_first from relay.nodes n
        where n.tenant_id = v_m.tenant_id and n.status = 'active' and n.owner_user = v_owner and n.id <> v_m.to_node
        order by n.created_at limit 1;
      continue when v_first is null;
      insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, created_at, tenant_id, expects_reply, owner_signed, person_user)
        values (v_m.from_node, v_m.from_agent, v_first, v_alias, v_m.body, v_m.reply_to, v_m.created_at, v_m.tenant_id,
                v_m.expects_reply, v_m.owner_signed, v_owner);
    end if;
    update relay.messages set acked_at = now() where id = v_m.id;
    v_done := v_done + 1;
  end loop;
  raise notice '補送 % 封', v_done;
end;
$$;

commit;
