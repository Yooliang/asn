-- 寄給本人的信，手機沒開 App 時也留一列（#796）。原本只分送給最近 3 分鐘在線的 ASN，手機再開 App 沒有未讀也沒有提示。
--  - 只動 asn_relay_send_core 的「寄給人代號」那一段；其他寄信路徑不變。沒有回報 platform=android／ios 的節點行為完全不變。
--  - 手機要 30 天內開過（asn_presence 有紀錄）；未 ack 的信滿 100 封就不再多留（信仍在其他設備與往來記錄）。
--  - 沒有在線 ASN 時，原本留的那一列照舊，手機另外多一列。
--  - 沒有改資料表、沒有改權限。
-- 部署順序：本 migration 可先上；舊版手機不回報 platform，不受影響。
-- 回復：supabase/sql/rollback/20261104190000_owner_mail_phone_down.sql（換回上一版函式；已留的信不動）。
begin;

CREATE OR REPLACE FUNCTION public.asn_relay_send_core(p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid, p_expects_reply boolean DEFAULT NULL::boolean, p_signed_user uuid DEFAULT NULL::uuid, p_as_person boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_phones jsonb;
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
    -- 手機沒開 App 時也留一列，開 App 照一般信收到、算未讀。只認回報過平台的手機（認不出來的照舊），30 天內開過才算，積信有上限
    select coalesce(jsonb_agg(jsonb_build_object('node', t.node, 'agent', t.window_name, 'bell', t.bell_topic) order by t.node), '[]'::jsonb)
      into v_phones
      from (
        select distinct on (p.node) p.node, p.window_name, n.bell_topic
        from relay.asn_presence p join relay.nodes n on n.id = p.node
        where n.tenant_id = v_tenant and n.status = 'active' and n.owner_user = v_owner
          and n.platform in ('android', 'ios')
          and p.updated_at > now() - interval '30 days'
          and not exists (select 1 from relay.asn_presence q where q.node = p.node and q.updated_at > now() - interval '3 minutes')
          and (select count(*) from (select 1 from relay.messages m where m.to_node = p.node and m.acked_at is null and m.to_agent is distinct from v_alias limit 100) c) < 100
        order by p.node, p.updated_at desc
        limit 5
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
      v_bells := array[v_topic];
      for v_t in select value from jsonb_array_elements(v_phones) loop
        update relay.messages set fanout_id = v_id where id = v_id and fanout_id is null;
        insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply, owner_signed, person_user, fanout_id)
          values (p_from_node, v_from_agent, v_t->>'node', v_t->>'agent', p_body, p_reply_to, v_tenant, p_expects_reply, v_signed, v_owner, v_id);
        if not (v_t->>'bell' = any(v_bells)) then v_bells := v_bells || (v_t->>'bell'); end if;
      end loop;
      return jsonb_build_object('id', v_id, 'bell_topic', v_topic, 'bell_topics', to_jsonb(v_bells), 'fanout', 0);
    end if;
    v_targets := v_targets || v_phones;
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

commit;
