-- 拿掉 Irori 時代的角色節點 XISU（小良哥 2026-10-23 裁示：直接刪，之後再改 Irori，別讓它反過來影響收發室）。
-- 前提：20261023140000_reply_to_person 已套用（收信端不再把本人的信顯示成 XISU，寄給 XISU 的信保底轉給本人）。
-- 原則：本人的往來記錄一筆都不能少。不用 cascade；全部先備份、再改寫、最後才刪節點；整支在一個交易內，任何一步失敗全部還原。
--
-- 現況（2026-10-23 唯讀量測）XISU 被這些地方引用，處理方式如下：
--  1. relay.messages.from_node 239 筆、to_node 354 筆（含已送達 345 筆）→ 改寫成同租戶「本人名下最早的在線設備節點」（目前是 H，家用機）。
--     歷史信件的寄件／收件節點換成那台設備，視窗名、內文、時間、person_user 不動，往來記錄照樣查得到。
--  2. relay.messages 中「寄給 XISU、未 ack」共 9 封：最近 7 天、沒指定視窗（或指定本人代號）的，補扇出給本人（有在線 ASN 就每個視窗一列，
--     否則留一列在接手設備、視窗＝人代號，與寄信函式的離線行為相同），再把原信標成已 ack；其餘較舊或指定了視窗名的，也標成已 ack（已備份，免得改寫節點後被 H 一次收到舊信）。
--  3. relay.launches.requested_by 10 筆 → 改成接手設備。
--  4. relay.rooms.created_by 2 筆（沒有外鍵）→ 改成接手設備。
--  5. relay.tenants.character_node 1 筆 → 設為 null（欄位保留；寄信函式的 character_node 判斷自然落空，改走「本人名下設備」）。
--  6. 其餘有外鍵指向節點的表（roster、partners、partner_ops、partner_archives、asn_presence、asn_accounts、account_switches、
--     asn_update_requests、attachments、invites、secret_requests）實測 XISU 都是 0 筆；刪除時若有就會因外鍵擋下整個交易（secret_requests 是 cascade，會跟著清）。
--  7. relay.nodes 的 XISU 列（role=owner、家用機、希緒）→ 備份後刪除。刪除後租戶沒有 role=owner 的在線節點，而帳號切換等特權動作仍認 role=owner，
--     所以把接手設備升為 role=owner（trust 早已只看本人簽章，不看 role）。
--  8. 寄信函式 asn_relay_send：拿掉「to_node=XISU 改寄 character_node」的寫死邏輯；舊寫法 XISU、XISU/u:xxxx 在節點不存在時視同寄給本人位址（舊用戶端相容）。
--  9. 收信端程式（Rust 橋、機器橋、雲端代理、外掛、介面）沒有寫死 XISU，只有測試向量與說明文件提到，不需改程式。
-- 備份：relay._backup_xisu_20261023_{messages,launches,rooms,tenants,nodes}，確認沒問題後手動清掉。
-- 回復：從備份表把節點、tenants.character_node、各表的原值寫回（備份有完整列）；舊 XISU 的金鑰雜湊在 nodes 備份裡。
begin;

create table if not exists relay._backup_xisu_20261023_messages (like relay.messages);
create table if not exists relay._backup_xisu_20261023_launches (like relay.launches);
create table if not exists relay._backup_xisu_20261023_rooms (like relay.rooms);
create table if not exists relay._backup_xisu_20261023_tenants (like relay.tenants);
create table if not exists relay._backup_xisu_20261023_nodes (like relay.nodes);
revoke all on relay._backup_xisu_20261023_messages, relay._backup_xisu_20261023_launches, relay._backup_xisu_20261023_rooms,
  relay._backup_xisu_20261023_tenants, relay._backup_xisu_20261023_nodes from public, anon, authenticated;

insert into relay._backup_xisu_20261023_messages select m.* from relay.messages m
  where (m.from_node = 'XISU' or m.to_node = 'XISU') and not exists (select 1 from relay._backup_xisu_20261023_messages b where b.id = m.id);
insert into relay._backup_xisu_20261023_launches select l.* from relay.launches l
  where l.requested_by = 'XISU' and not exists (select 1 from relay._backup_xisu_20261023_launches b where b.id = l.id);
insert into relay._backup_xisu_20261023_rooms select r.* from relay.rooms r
  where r.created_by = 'XISU' and not exists (select 1 from relay._backup_xisu_20261023_rooms b where b.id = r.id);
insert into relay._backup_xisu_20261023_tenants select t.* from relay.tenants t
  where t.character_node = 'XISU' and not exists (select 1 from relay._backup_xisu_20261023_tenants b where b.id = t.id);
insert into relay._backup_xisu_20261023_nodes select n.* from relay.nodes n
  where n.id = 'XISU' and not exists (select 1 from relay._backup_xisu_20261023_nodes b where b.id = n.id);

do $mig$
declare
  v_tenant uuid;
  v_owner uuid;
  v_alias text;
  v_h text;
  v_m record;
  v_t record;
  v_head uuid;
  v_id uuid;
  v_n int;
begin
  select tenant_id into v_tenant from relay.nodes where id = 'XISU';
  if v_tenant is null then return; end if;   -- 已經不在：可重跑
  select owner_user into v_owner from relay.tenants where id = v_tenant;
  v_alias := public.asn_person_alias(v_owner);
  select n.id into v_h from relay.nodes n
    where n.tenant_id = v_tenant and n.status = 'active' and n.id <> 'XISU' and n.owner_user = v_owner
    order by n.created_at limit 1;
  if v_h is null or v_alias is null then
    raise exception '租戶沒有可接手的設備節點或本人代號，不刪除 XISU';
  end if;

  -- 2. 寄給 XISU、未 ack、最近 7 天、沒指定視窗（或指定本人代號）的信：補扇出給本人
  for v_m in
    select * from relay.messages
    where to_node = 'XISU' and acked_at is null and created_at > now() - interval '7 days'
      and (to_agent is null or to_agent = '' or to_agent = v_alias)
    order by created_at, id
  loop
    v_head := null; v_n := 0;
    for v_t in
      select p.node, p.window_name from relay.asn_presence p join relay.nodes n on n.id = p.node
      where n.tenant_id = v_tenant and n.status = 'active' and n.owner_user = v_owner and n.id <> 'XISU'
        and p.updated_at > now() - interval '3 minutes'
      order by p.updated_at desc, p.node, p.window_name limit 10
    loop
      insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, created_at, tenant_id, expects_reply, owner_signed, person_user, fanout_id)
        values (case when v_m.from_node = 'XISU' then v_h else v_m.from_node end, v_m.from_agent, v_t.node, v_t.window_name, v_m.body, v_m.reply_to,
                v_m.created_at, v_m.tenant_id, v_m.expects_reply, v_m.owner_signed, v_owner, v_head)
        returning id into v_id;
      if v_head is null then
        v_head := v_id;
        update relay.messages set fanout_id = v_head where id = v_head;
      end if;
      v_n := v_n + 1;
    end loop;
    if v_n = 0 then
      insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, created_at, tenant_id, expects_reply, owner_signed, person_user)
        values (case when v_m.from_node = 'XISU' then v_h else v_m.from_node end, v_m.from_agent, v_h, v_alias, v_m.body, v_m.reply_to,
                v_m.created_at, v_m.tenant_id, v_m.expects_reply, v_m.owner_signed, v_owner);
    end if;
  end loop;
  -- 所有還沒 ack 的「寄給 XISU」信標成已 ack（處理過的、或太舊／指定視窗已無人可收的；原列已備份）
  update relay.messages set acked_at = now() where to_node = 'XISU' and acked_at is null;

  -- 1. 歷史信件改寫到接手設備（欄位其餘不動）
  update relay.messages set from_node = v_h where from_node = 'XISU';
  update relay.messages set to_node = v_h where to_node = 'XISU';
  -- 3、4、5
  update relay.launches set requested_by = v_h where requested_by = 'XISU';
  update relay.rooms set created_by = v_h where created_by = 'XISU';
  update relay.tenants set character_node = null where character_node = 'XISU';

  -- 7. 刪節點（任何外鍵殘留會讓整個交易失敗），再把接手設備升為擁有者角色
  delete from relay.nodes where id = 'XISU';
  update relay.nodes set role = 'owner'
    where id = v_h and not exists (select 1 from relay.nodes o where o.tenant_id = v_tenant and o.role = 'owner' and o.status = 'active');
end;
$mig$;

create or replace function public.asn_relay_send(
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
  -- 舊寫法相容：Irori 時代的角色節點 XISU 已拿掉。節點不存在時，寄給「XISU」「XISU/u:xxxx」（沒指定視窗或指定本人代號）一律視同寄給本人位址。
  if p_to_node = 'XISU' and not exists (select 1 from relay.nodes where id = 'XISU')
     and (p_to_agent is null or p_to_agent = '' or p_to_agent ~ '^u:[0-9a-f]{12}$') then
    if v_alias is null then
      return jsonb_build_object('error', 'unknown_to_node');
    end if;
    p_to_node := v_alias;
  end if;

  -- 與節點無關的本人位址：to_node 直接寫人代號（例如 u:3cda66252c34）。只認這個租戶擁有者的代號；
  -- 視同「寄給人代號」，後面走同一條扇出。舊寫法「節點/u:xxx」（含 XISU/u:xxx）不經過這裡，照舊可用。
  if p_to_node ~ '^u:[0-9a-f]{12}$' then
    if v_alias is null or p_to_node <> v_alias then
      return jsonb_build_object('error', 'unknown_to_node');
    end if;
    p_to_agent := v_alias;
    select coalesce(
        (select t.character_node from relay.tenants t where t.id = v_tenant),
        (select o.id from relay.nodes o where o.tenant_id = v_tenant and o.role = 'owner' and o.status = 'active' limit 1),
        (select n.id from relay.nodes n where n.tenant_id = v_tenant and n.status = 'active' and n.owner_user = v_owner order by n.created_at limit 1))
      into v_to;
  end if;

  -- 保底（角色節點不再當本人的信箱）：寄給租戶「本人的角色節點」（租戶主節點 role=owner，或租戶設定的角色節點，例如 XISU）、
  -- 且沒指定視窗（或指定的就是本人代號），而那個節點上沒有在線的 ASN 視窗 → 一律改寄本人位址，照常扇出到本人各 ASN 視窗。
  -- 舊用戶端（舊橋、舊外掛、舊 AI 技能）照舊信頭只寫節點代號回信時也到得了本人。
  -- 不動的情形：指定了別的視窗名、節點上有在線的 ASN（那是真的設備）、寄件人就是該節點自己、不同租戶。
  if v_alias is not null and v_owner is not null
     and (p_to_agent is null or p_to_agent = '' or p_to_agent = v_alias)
     and v_to is distinct from p_from_node
     and exists (
       select 1 from relay.nodes rn
       where rn.id = v_to and rn.tenant_id = v_tenant and rn.status = 'active'
         and (rn.role = 'owner' or rn.id = (select t.character_node from relay.tenants t where t.id = v_tenant)))
     and not exists (
       select 1 from relay.asn_presence ap
       where ap.node = v_to and ap.updated_at > now() - interval '3 minutes') then
    p_to_agent := v_alias;
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

revoke all on function public.asn_relay_send(text, text, text, text, text, uuid, boolean, uuid, boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_send(text, text, text, text, text, uuid, boolean, uuid, boolean) to service_role;

commit;
