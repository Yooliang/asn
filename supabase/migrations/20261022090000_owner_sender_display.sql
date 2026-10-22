-- 本人寄信的寄件人說明（#108 後續）。不改任何既有欄位的值：
--  1. irori_relay_send：to_node 可直接寫人代號（u:xxxxxxxxxxxx，與節點無關），視同「寄給人代號」走 #108 的扇出；
--     舊寫法「節點/u:xxx」（含 XISU/u:xxx）照舊可用。代號不是這個租戶擁有者的 → unknown_to_node。
--  2. irori_relay_inbox／irori_relay_inbox_agent：多回三個選填欄位，給橋組「寄件人：…」說明行：
--     sender_display（只有本人簽章的信有：帳號的顯示名稱，relay.tenants.owner_name，其餘 null）、
--     sender_device（實際寄出節點的名稱 relay.nodes.name，不是節點代號）、
--     sender_engine（該視窗在名單裡的引擎 relay.roster.engine；雲端代理節點固定 'cloud'；查不到 null）。
--     舊用戶端不認得新欄位，直接忽略；from_node／from_agent／trust 的值不變。
--  3. asn_account_name：讀／改帳號層的「我的名字」（relay.tenants.owner_name），給電腦版與手機版設定頁用。
-- 先不套用：部署由負責的 session 處理。
begin;

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

-- 帳號層的「我的名字」（所有設備共用）＝relay.tenants.owner_name（註冊時由登入資料的 name，沒有就 email @ 前面那段寫入）。
-- 設備層的「設備名稱」是節點的 name（各設備自己改）。信頭說明行的名字一律用前者，設備名用後者。
-- asn_account_name(使用者, 新名字, 預設名字)：新名字給了就改（1～40 字、不含控制字元）；沒給就讀。
-- 讀的時候若還是建租戶時的預設「朋友」（從沒設過名字），且呼叫端帶了預設名字（登入資料的 name 或 email 前段），就先寫入再回傳。
-- Edge Function relay 的 account_name 動作呼叫它，一律要本人的登入憑證（節點金鑰拿不到）。
create or replace function public.asn_account_name(p_user uuid, p_name text default null, p_default text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_t relay.tenants%rowtype;
  v_new text;
begin
  if p_user is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select * into v_t from relay.tenants where owner_user = p_user;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_name is not null then
    v_new := btrim(p_name);
    if char_length(v_new) not between 1 and 40 or v_new ~ '[[:cntrl:]]' then
      return jsonb_build_object('error', 'bad_request');
    end if;
  elsif v_t.owner_name = '朋友' and nullif(btrim(coalesce(p_default, '')), '') is not null then
    v_new := left(btrim(p_default), 40);
  end if;
  if v_new is not null and v_new is distinct from v_t.owner_name then
    update relay.tenants set owner_name = v_new where id = v_t.id;
    v_t.owner_name := v_new;
  end if;
  return jsonb_build_object('name', v_t.owner_name);
end;
$function$;

revoke all on function public.asn_account_name(uuid, text, text) from public, anon, authenticated;
grant execute on function public.asn_account_name(uuid, text, text) to service_role;

commit;
