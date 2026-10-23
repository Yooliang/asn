-- 真人好友與群組 第 1a 期（後台）之二：群組讀寫函式改成「看成員表」、讀取時依讀者重算 trust、對外成員代號映射、額度。
-- 以 repo 最新定義為底：asn_relay_room_post（20261023050000）、asn_relay_room_read／list／members／pin_get（20261020000200，改名見 20261023040000）。
-- 與舊版的差異（單一租戶的舊群組結果不變，由 tests/groups_p1a_sql.test.mjs 的等價案例鎖住）：
--  1. 存取：從「群組在不在呼叫者的租戶」改成「呼叫者的成員鍵（節點、視窗、簽章過的 ~u:<帳號>）在不在成員表」；~owner 仍只限建立地租戶。
--  2. room_read：trust 依讀者重算（只有「寄件人與讀者同一個租戶」且寫入時是本人簽章才是 owner）；多回 from_kind、relation、from_label、from_owner_name、
--     is_seed、wake_ok；別租戶成員的鍵與 mentions 一律回 x:<member_ref>，不含節點代號。看不到加入前的訊息（visible_from_seq）。
--  3. room_post：每成員每群組每小時 20 則（~owner 不限；開頭紀錄與系統訊息不計）；每則 @ 最多 8 位；別人叫醒我的 AI 有額度（每群組每小時 10 次、跨群組 30 次、可關閉），超過只記在 suppressed；
--     門鈴不再限同租戶；mentions 可帶對外代號。
--  4. 要帶本人簽章的讀取另開新函式 asn_relay_group_read／list／members（多一個 p_signed_user）；原本 asn_relay_room_read／list／members 的簽章不變（改名守門與舊呼叫端依賴它），
--     改成呼叫新函式、不帶簽章＝行為與以前相同。Edge 驗過 x-asn-user 之後才改呼叫新函式。
begin;

create or replace function public.asn_relay_room_post(p_node text, p_agent text, p_room text, p_body text, p_mentions text[], p_owner boolean DEFAULT false, p_signed_user uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_key text := relay.room_actor_key(p_node, p_agent, p_owner, p_signed_user, p_room);
  v_trust text;
  v_seq bigint;
  v_mentions text[];
  v_recent int;
  v_rt uuid;
  v_st uuid;
  v_sup text[];
  v_human boolean;
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_body is null or char_length(p_body) < 1 or char_length(p_body) > 20000 then
    return jsonb_build_object('error', 'bad_body');
  end if;
  if not relay.room_can(p_room, p_node, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  if not p_owner and p_agent is not null and btrim(p_agent) <> ''
     and not exists (select 1 from relay.roster where node = p_node and name = p_agent) then
    return jsonb_build_object('error', 'unknown_agent');
  end if;
  if v_key <> '~owner' then
    select count(*) into v_recent from relay.room_messages
      where room_id = p_room and from_member = v_key and at > now() - interval '1 hour'
        and not is_seed and from_kind is distinct from 'system';
    if v_recent >= 20 then
      return jsonb_build_object('error', 'rate_limited');
    end if;
  end if;
  v_trust := case when p_owner or public.asn_user_owns_node(p_signed_user, p_node)
                  then 'owner' else 'member' end;
  select coalesce(array_agg(s.m), array[]::text[]) into v_mentions from (
    select distinct q.rk as m from (
      select relay.room_resolve_key(p_room, x) as rk from unnest(coalesce(p_mentions, array[]::text[])) x
    ) q
    where q.rk is not null and q.rk <> v_key and relay.room_is_member(p_room, q.rk) order by q.rk limit 8
  ) s;
  select tenant_id into v_rt from relay.rooms where id = p_room;
  v_st := relay.member_tenant(v_key, v_rt);
  v_sup := relay.room_wake_filter(p_room, v_st, v_rt, v_mentions);
  v_human := v_trust = 'owner' or v_key = '~owner' or v_key like '~u:%';
  v_seq := relay.room_append(p_room, v_key, v_trust, p_body, v_mentions, case when v_human then 'human' else 'ai' end, false,
                             (select t.owner_user from relay.tenants t where t.id = v_st), now(), v_sup);
  update relay.room_members set read_seq = v_seq where room_id = p_room and member = v_key;
  return jsonb_build_object('seq', v_seq, 'from', v_key, 'bell_topics', to_jsonb(relay.room_bells(p_room)), 'suppressed', to_jsonb(v_sup));
end;
$function$;

create or replace function public.asn_relay_group_read(p_node text, p_agent text, p_room text, p_since bigint, p_limit integer, p_owner boolean, p_tail boolean, p_mark boolean, p_signed_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_key text := relay.room_actor_key(p_node, p_agent, p_owner, p_signed_user, p_room);
  v_read bigint;
  v_vis bigint;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_since bigint;
  v_msgs jsonb;
  v_max bigint;
  v_last bigint;
  v_rt uuid;
  v_reader uuid;
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not relay.room_can(p_room, p_node, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  select r.tenant_id, r.last_seq into v_rt, v_last from relay.rooms r where r.id = p_room;
  v_reader := relay.member_tenant(v_key, v_rt);
  select read_seq, visible_from_seq into v_read, v_vis from relay.room_members where room_id = p_room and member = v_key;
  v_since := coalesce(p_since, case when p_tail then null else v_read end);
  select coalesce(jsonb_agg(jsonb_build_object(
      'seq', s.seq,
      'from', relay.room_ext_key(p_room, s.from_member, v_reader, v_rt),
      'from_name', relay.room_display_name(p_room, s.from_member),
      'trust', case when s.trust = 'owner' and relay.member_tenant(s.from_member, v_rt) is not distinct from v_reader then 'owner' else 'member' end,
      'from_kind', relay.msg_kind(s.from_kind, s.from_member, s.trust),
      'relation', case
        when s.from_kind = 'system' then 'system'
        when relay.member_tenant(s.from_member, v_rt) is not distinct from v_reader
          then case when relay.msg_kind(s.from_kind, s.from_member, s.trust) = 'human' then 'mine' else 'mine_ai' end
        else 'other' end,
      'from_owner_name', case when relay.msg_kind(s.from_kind, s.from_member, s.trust) = 'ai' then relay.room_owner_name(s.from_member, v_rt) end,
      'from_label', case when relay.msg_kind(s.from_kind, s.from_member, s.trust) = 'ai'
        then relay.room_display_name(p_room, s.from_member) || '（' || coalesce(relay.room_owner_name(s.from_member, v_rt), '?') || '）'
        else relay.room_display_name(p_room, s.from_member) end,
      'body', s.body,
      'mentions', (select coalesce(jsonb_agg(relay.room_ext_key(p_room, mk.k, v_reader, v_rt) order by mk.i), '[]'::jsonb)
                   from unnest(s.mentions) with ordinality as mk(k, i)),
      'at', s.at,
      'is_seed', s.is_seed,
      'wake_ok', not (v_key = any(s.suppressed))
    ) order by s.seq), '[]'::jsonb), max(s.seq)
  into v_msgs, v_max
  from (
    select * from (
      select m.* from relay.room_messages m
      where m.room_id = p_room and m.seq > coalesce(v_vis, 0) and (v_since is null or m.seq > v_since)
      order by case when v_since is null then -m.seq else m.seq end
      limit v_limit
    ) t
  ) s;
  if v_max is not null and coalesce(p_mark, p_since is null and not coalesce(p_tail, false)) then
    update relay.room_members set read_seq = greatest(read_seq, v_max) where room_id = p_room and member = v_key;
  end if;
  return jsonb_build_object('messages', v_msgs, 'last_seq', v_last, 'key', v_key);
end;
$function$;

create or replace function public.asn_relay_group_list(p_node text, p_owner boolean, p_signed_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_out jsonb;
  v_t uuid := relay.node_tenant(p_node);
  v_u uuid := relay.signed_user(p_node, p_signed_user);
begin
  if p_owner and not relay.room_actor_is_owner(p_node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'name', r.name, 'created_at', r.created_at, 'last_seq', r.last_seq, 'auto_prefixes', to_jsonb(r.auto_prefixes),
    'last_at', lm.at, 'last_from', relay.room_ext_key(r.id, lm.from_member, v_t, r.tenant_id),
    'last_from_name', case when lm.from_member is null then null else relay.room_display_name(r.id, lm.from_member) end,
    'last_body', left(lm.body, 120),
    'external', relay.room_has_external(r.id),
    'is_host', v_u is not null and relay.room_host(r.id) = v_u,
    'mine', (select coalesce(jsonb_agg(jsonb_build_object(
        'member', rm.member, 'read_seq', rm.read_seq,
        'unread', (select count(*) from relay.room_messages m
                   where m.room_id = r.id and m.seq > greatest(rm.read_seq, rm.visible_from_seq) and m.from_member <> rm.member
                     and not m.is_seed and m.from_kind is distinct from 'system')
      ) order by rm.member), '[]'::jsonb)
      from relay.room_members rm
      where rm.room_id = r.id and rm.left_at is null
        and relay.room_member_is_mine(rm.member, p_node, p_owner, v_u, r.tenant_id, v_t)),
    'members', relay.room_members_view(r.id, v_t)
  ) order by coalesce(lm.at, r.created_at) desc), '[]'::jsonb)
  into v_out
  from relay.rooms r
  left join lateral (
    select m.at, m.from_member, m.body from relay.room_messages m
    where m.room_id = r.id
      and m.seq > coalesce((select min(rm.visible_from_seq) from relay.room_members rm
                            where rm.room_id = r.id and rm.left_at is null
                              and relay.room_member_is_mine(rm.member, p_node, p_owner, v_u, r.tenant_id, v_t)), 0)
    order by m.seq desc limit 1
  ) lm on true
  where r.archived_at is null
    and exists (
      select 1 from relay.room_members rm
      where rm.room_id = r.id and rm.left_at is null
        and relay.room_member_is_mine(rm.member, p_node, p_owner, v_u, r.tenant_id, v_t)
    );
  return jsonb_build_object('rooms', v_out);
end;
$function$;

create or replace function public.asn_relay_group_members(p_node text, p_agent text, p_room text, p_owner boolean, p_signed_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_key text := relay.room_actor_key(p_node, p_agent, p_owner, p_signed_user, p_room);
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not relay.room_can(p_room, p_node, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  return jsonb_build_object('key', v_key,
    'room', (select jsonb_build_object('id', r.id, 'name', r.name, 'auto_prefixes', to_jsonb(r.auto_prefixes),
                                       'external', relay.room_has_external(r.id))
             from relay.rooms r where r.id = p_room),
    'members', relay.room_members_view(p_room, relay.member_tenant(v_key, (select r.tenant_id from relay.rooms r where r.id = p_room))));
end;
$function$;

-- 置頂（讀）：同樣改成看成員表，別租戶的成員也讀得到
create or replace function public.asn_relay_room_pin_get(p_node text, p_agent text, p_room text, p_owner boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_key text := relay.room_caller_key(p_node, p_agent, p_owner);
  v_pin relay.room_pins%rowtype;
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not relay.room_can(p_room, p_node, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  select * into v_pin from relay.room_pins where room_id = p_room;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('body', v_pin.body, 'version', v_pin.version, 'updated_at', v_pin.updated_at);
end;
$function$;

-- 舊簽章原樣保留（20261023040000 的改名守門、舊呼叫端都靠它），改成呼叫上面的新函式、不帶本人簽章
create or replace function public.asn_relay_room_read(p_node text, p_agent text, p_room text, p_since bigint, p_limit integer, p_owner boolean DEFAULT false, p_tail boolean DEFAULT false, p_mark boolean DEFAULT NULL::boolean)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO ''
AS $function$
  select public.asn_relay_group_read(p_node, p_agent, p_room, p_since, p_limit, p_owner, p_tail, p_mark, null::uuid);
$function$;

create or replace function public.asn_relay_room_list(p_node text, p_owner boolean DEFAULT false)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO ''
AS $function$
  select public.asn_relay_group_list(p_node, p_owner, null::uuid);
$function$;

create or replace function public.asn_relay_room_members(p_node text, p_agent text, p_room text, p_owner boolean DEFAULT false)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO ''
AS $function$
  select public.asn_relay_group_members(p_node, p_agent, p_room, p_owner, null::uuid);
$function$;

revoke all on function public.asn_relay_group_read(text, text, text, bigint, integer, boolean, boolean, boolean, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_group_read(text, text, text, bigint, integer, boolean, boolean, boolean, uuid) to service_role;
revoke all on function public.asn_relay_group_list(text, boolean, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_group_list(text, boolean, uuid) to service_role;
revoke all on function public.asn_relay_group_members(text, text, text, boolean, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_group_members(text, text, text, boolean, uuid) to service_role;

commit;
