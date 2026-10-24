-- 群組成員清單多帶「線上狀態」與「引擎」（小良哥 10-25）：群組訊息的發言者頭像要看得出離線、AI 頭像右下角要有廠商小圖。
-- 規則（唯一的真相放在 relay.room_member_presence）：
--   真人不帶這兩個欄位；AI 視窗（節點~視窗名）＝ relay.roster 該列 seen_at 在 3 分鐘內為 online=true，否則 false（與名單的在線規則相同）；
--   只有節點（沒有視窗名）的舊成員＝看 relay.nodes.last_seen_at；engine 取 roster.engine，沒有時取節點 kind（claude／gpt／gemini／grok）。
--   只給布林與引擎名，不給節點代號、設備名與時間；外部帳號的 AI 成員也只拿這兩個欄位，不外洩別人的節點資訊。
-- 相容：全部是新增欄位，舊用戶端照舊；新用戶端沒有 online 欄位就當在線、沒有 engine 就當不明廠商。
-- 其餘（room_members_view 的既有欄位）與 20261024160000 完全相同。
-- 回復：把 20261024160000 的 room_members_view 定義再套一次；room_member_presence 可留著不影響。
begin;

create or replace function relay.room_member_presence(p_member text)
 returns jsonb language sql stable security definer set search_path to ''
as $function$
  select case
    when p_member like '~%' then '{}'::jsonb
    when position('~' in p_member) > 0 then (
      select jsonb_strip_nulls(jsonb_build_object('online', coalesce(r.seen_at > now() - interval '3 minutes', false), 'engine', coalesce(r.engine, case when n.kind in ('claude','gpt','gemini','grok') then n.kind end)))
      from (select 1) d
      left join relay.roster r on r.node = split_part(p_member, '~', 1) and r.name = substr(p_member, position('~' in p_member) + 1)
      left join relay.nodes n on n.id = split_part(p_member, '~', 1))
    else (
      select jsonb_strip_nulls(jsonb_build_object('online', coalesce(n.last_seen_at > now() - interval '3 minutes', false), 'engine', case when n.kind in ('claude','gpt','gemini','grok') then n.kind end))
      from (select 1) d left join relay.nodes n on n.id = p_member)
  end;
$function$;

create or replace function relay.room_members_view(p_room text, p_reader uuid)
 returns jsonb language sql stable security definer set search_path to ''
as $function$
  select coalesce(jsonb_agg(
    case when x.mt is not distinct from p_reader then jsonb_build_object(
      'key', x.member,
      'name', relay.room_display_name(p_room, x.member),
      'role', x.role,
      'kind', case when x.member = '~owner' or x.member like '~u:%' then 'owner'
                   when position('~' in x.member) > 0 then 'window'
                   else coalesce(x.nkind, 'other') end,
      'node_role', case when x.member = '~owner' or x.member like '~u:%' then 'owner' else coalesce(x.nrole, 'member') end,
      'joined_via', x.joined_via,
      'member_kind', case when x.member = '~owner' or x.member like '~u:%' then 'human' else 'ai' end,
      'owner_name', relay.room_owner_name(x.member, x.rt),
      'label', case when x.member = '~owner' or x.member like '~u:%' then relay.room_display_name(p_room, x.member)
                    else relay.room_display_name(p_room, x.member) || '（' || coalesce(relay.room_owner_name(x.member, x.rt), '?') || '）' end,
      'display_label', relay.room_display_label(p_room, x.member, p_reader, x.rt, not (x.member = '~owner' or x.member like '~u:%')),
      'allow_others', case when x.member = '~owner' or x.member like '~u:%' then null else x.allow_others end,
      'mine', true) || relay.room_member_presence(x.member)
    else jsonb_build_object(
      'key', 'x:' || x.member_ref::text,
      'name', relay.room_display_name(p_room, x.member),
      'role', x.role,
      'kind', case when x.member = '~owner' or x.member like '~u:%' then 'human' else 'ai' end,
      'member_kind', case when x.member = '~owner' or x.member like '~u:%' then 'human' else 'ai' end,
      'owner_name', relay.room_owner_name(x.member, x.rt),
      'label', case when x.member = '~owner' or x.member like '~u:%' then relay.room_display_name(p_room, x.member)
                    else relay.room_display_name(p_room, x.member) || '（' || coalesce(relay.room_owner_name(x.member, x.rt), '?') || '）' end,
      'display_label', relay.room_display_label(p_room, x.member, p_reader, x.rt, not (x.member = '~owner' or x.member like '~u:%')),
      'allow_others', case when x.member = '~owner' or x.member like '~u:%' then null else x.allow_others end,
      'mine', false) || relay.room_member_presence(x.member)
    end order by x.joined_at, x.member), '[]'::jsonb)
  from (
    select m.member, m.member_ref, m.role, m.joined_at, m.joined_via, r.tenant_id as rt,
           relay.member_tenant(m.member, r.tenant_id) as mt, n.kind as nkind, n.role as nrole, m.allow_others
    from relay.room_members m
    join relay.rooms r on r.id = m.room_id
    left join relay.nodes n on n.id = split_part(m.member, '~', 1) and m.member not like '~%'
    where m.room_id = p_room and m.left_at is null
  ) x;
$function$;

revoke all on function relay.room_member_presence(text) from public, anon, authenticated;

commit;
