-- #14 R7：信任與角色去 Irori 化（設計 D5，docs/design/ONBOARDING.md 第 7.2 節與 9.4 表 R7）。
-- 目的：trust=owner 只代表「帳號擁有者本人親手打的字」＝本人簽章（relay.messages.owner_signed；群組為簽章或 p_owner），
--       不再因為「寄件節點的 role 是 owner」（Irori 時代的角色節點，舊租戶的 XISU）就被標成擁有者。
-- 做法與設計的差異：設計寫「新增 human 節點」，實作改走已上線的本人簽章路徑（#108／#158 以來 ASN、手機都靠登入憑證簽章），
--       因此不新增 node_type 欄位也不新增節點；本人簽章比「金鑰藏在 Rust 端的 human 節點」更直接，也不需要多發一把金鑰。
-- 本檔只改三處函式的必要處（以 repo 最新定義為底）：
--  1. asn_relay_inbox、asn_relay_inbox_agent：trust 只看 owner_signed（原本 f.role = 'owner' or owner_signed）。
--  2. asn_relay_room_post：群組發言的 trust 拿掉「relay.room_actor_is_owner(p_node)」（角色節點發言不再自動是 owner）；
--     p_owner（舊後台 irori-api 的人登入路徑）與本人簽章照舊。群組成員身分（relay.room_caller_key）不動，舊租戶角色節點照常能以 ~owner 身分發言。
--  3. relay.room_member_name（兩個多載）：~owner 的顯示名不再寫死「小良哥」，備用文字改成中性的「帳號擁有者」
--     （兩個參數的版本本來就取 relay.tenants.owner_name，只改沒有帳號名稱時的備用字）。
-- 刻意不動（以「不影響現有使用」為準）：role = 'owner' 仍當作「特權動作」的授權條件——
--     acct_list／acct_switch／acct_switch_status、invite、reissue、update、launch／launchers（另有本人簽章路徑）、room_actor_is_owner。
--     資料也不降級：舊租戶的 role = 'owner' 節點維持原值，只是它寄的信不再被標 trust=owner。
-- 回復：把上述三處函式換回 20261022090000／20261023040000 之前的定義（inbox 的 trust 運算式改回 f.role = 'owner' or m.owner_signed；
--     room_post 補回 or relay.room_actor_is_owner(p_node)）；本檔沒有改任何資料，回復不需要資料動作。
-- 不改權限（create or replace 保留既有授權）。可重跑。
-- 先不套用：部署由負責的 session 處理（順序：先套本 migration，再部署 relay 函式；函式沒有因本 migration 而改介面）。
begin;

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
      'fanout_id', m.fanout_id,
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
      'fanout_id', m.fanout_id,
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

create or replace function public.asn_relay_room_post(p_node text, p_agent text, p_room text, p_body text, p_mentions text[], p_owner boolean DEFAULT false, p_signed_user uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_key text := relay.room_caller_key(p_node, p_agent, p_owner);
  v_trust text;
  v_seq bigint;
  v_mentions text[];
  v_topics text[];
  v_recent int;
  v_t uuid := relay.node_tenant(p_node);
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_body is null or char_length(p_body) < 1 or char_length(p_body) > 20000 then
    return jsonb_build_object('error', 'bad_body');
  end if;
  if not relay.room_in_tenant(p_room, p_node) or not relay.room_is_member(p_room, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  if not p_owner and p_agent is not null and btrim(p_agent) <> ''
     and not exists (select 1 from relay.roster where node = p_node and name = p_agent) then
    return jsonb_build_object('error', 'unknown_agent');
  end if;
  if v_key <> '~owner' then
    select count(*) into v_recent from relay.room_messages
      where room_id = p_room and from_member = v_key and at > now() - interval '1 hour';
    if v_recent >= 20 then
      return jsonb_build_object('error', 'rate_limited');
    end if;
  end if;
  v_trust := case when p_owner or public.asn_user_owns_node(p_signed_user, p_node)
                  then 'owner' else 'member' end;
  select coalesce(array_agg(s.m), array[]::text[]) into v_mentions from (
    select distinct m from unnest(coalesce(p_mentions, array[]::text[])) m
    where m <> v_key and relay.room_is_member(p_room, m) order by m limit 8
  ) s;
  update relay.rooms set last_seq = last_seq + 1 where id = p_room returning last_seq into v_seq;
  insert into relay.room_messages (room_id, seq, from_member, trust, body, mentions)
    values (p_room, v_seq, v_key, v_trust, p_body, v_mentions);
  update relay.room_members set read_seq = v_seq where room_id = p_room and member = v_key;
  select coalesce(array_agg(distinct n.bell_topic), array[]::text[]) into v_topics
    from relay.room_members rm join relay.nodes n on n.id = split_part(rm.member, '~', 1) and n.status = 'active'
      and n.tenant_id is not distinct from v_t
    where rm.room_id = p_room and rm.left_at is null and rm.member <> '~owner';
  return jsonb_build_object('seq', v_seq, 'from', v_key, 'bell_topics', to_jsonb(v_topics));
end;
$function$;

create or replace function relay.room_member_name(p_key text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when p_key = '~owner' then '帳號擁有者'
    when position('~' in p_key) > 0 then substr(p_key, position('~' in p_key) + 1)
    else coalesce((select name from relay.nodes where id = p_key), p_key)
  end;
$function$;

create or replace function relay.room_member_name(p_key text, p_tenant uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when p_key = '~owner' then coalesce((select owner_name from relay.tenants where id = p_tenant), '帳號擁有者')
    when position('~' in p_key) > 0 then substr(p_key, position('~' in p_key) + 1)
    else coalesce((select name from relay.nodes where id = p_key and tenant_id is not distinct from p_tenant), p_key)
  end;
$function$;

commit;
