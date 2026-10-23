-- 群組第 1 期補強 C：成員清單回報各 AI 目前的「接受別人點名」值（allow_others；真人成員為 null）。
-- 只改 relay.room_members_view（以 20261023170000 的定義為基礎，加一個欄位）；函式簽章不變，不新增 public 函式，舊用戶端忽略新欄位。
-- 另改 public.asn_relay_attach_access（群組附件下載授權補上真人成員的設備；簽章不變）。
-- 回復：把 20261023170000 裡的 relay.room_members_view 定義再套一次，並把 20261022020000 的 attach_access 定義（函式名改回 asn_relay_attach_access）再套一次。
begin;

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
      'allow_others', case when x.member = '~owner' or x.member like '~u:%' then null else x.allow_others end,
      'mine', true)
    else jsonb_build_object(
      'key', 'x:' || x.member_ref::text,
      'name', relay.room_display_name(p_room, x.member),
      'role', x.role,
      'kind', case when x.member = '~owner' or x.member like '~u:%' then 'human' else 'ai' end,
      'member_kind', case when x.member = '~owner' or x.member like '~u:%' then 'human' else 'ai' end,
      'owner_name', relay.room_owner_name(x.member, x.rt),
      'label', case when x.member = '~owner' or x.member like '~u:%' then relay.room_display_name(p_room, x.member)
                    else relay.room_display_name(p_room, x.member) || '（' || coalesce(relay.room_owner_name(x.member, x.rt), '?') || '）' end,
      'allow_others', case when x.member = '~owner' or x.member like '~u:%' then null else x.allow_others end,
      'mine', false)
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

-- 群組附件下載授權：真人成員的設備也能下載（沒有外部成員的群組恢復附件）。簽章與回傳不變。
create or replace function public.asn_relay_attach_access(p_node text, p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  a relay.attachments%rowtype;
  v_t uuid := relay.node_tenant(p_node);
  v_ok boolean := false;
begin
  select * into a from relay.attachments where id = p_id and tenant_id is not distinct from v_t and status <> 'pending';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if a.owner_node = p_node then
    v_ok := true;
  elsif a.message_id is not null then
    v_ok := exists (
      select 1 from relay.messages m
      where m.id = a.message_id
        and (m.to_node = p_node
          or (m.fanout_id is not null and exists (select 1 from relay.messages c where c.fanout_id = m.fanout_id and c.to_node = p_node))
          or (m.person_user is not null and exists (select 1 from relay.nodes pn where pn.id = p_node and pn.owner_user = m.person_user))));
  elsif a.room_id is not null then
    v_ok := exists (select 1 from relay.room_members rm
      where rm.room_id = a.room_id and rm.left_at is null and split_part(rm.member, '~', 1) = p_node)
      -- 群組補強 C：真人成員（~owner、~u:帳號）沒有節點前綴，原本下載授權對他們永遠不成立；同租戶的節點視同該真人的設備
      or exists (select 1 from relay.room_members rm join relay.rooms r on r.id = rm.room_id
        where rm.room_id = a.room_id and rm.left_at is null and (rm.member = '~owner' or rm.member like '~u:%')
          and relay.member_tenant(rm.member, r.tenant_id) is not distinct from v_t);
  end if;
  if not v_ok then
    return jsonb_build_object('error', 'not_found');
  end if;
  if a.status = 'expired' or a.expires_at <= now() or a.removed_at is not null then
    return jsonb_build_object('error', 'expired');
  end if;
  return jsonb_build_object('path', a.storage_path, 'name', a.name, 'mime', a.mime, 'bytes', a.bytes);
end;
$function$;

commit;
