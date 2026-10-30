-- 外部成員的群組也能傳附件（小良哥 2026-10-30 指示，提前做設計稿第 3 期的「群組成員就能下載」）。
-- 只改 public.asn_relay_attach_access（簽章與回傳不變）：
--   · 群組附件（room_id 有值、沒綁一對一信件）：只要呼叫的設備是這個群組現有成員的設備就能下載，不再要求和附件同租戶
--     （成員＝節點前綴等於這台，或這台屬於某位真人成員的租戶；退出的成員 left_at 有值，下載不到）
--   · 一對一附件與自己上傳的：照舊，同租戶才行（owner／收件人／扇出／person_user 規則不變）
--   · 群組外的人、群組外的別的租戶：一律 not_found
-- 回復：把 20261023180000_groups_p1c_allow_others.sql 裡 asn_relay_attach_access 的定義再套一次。
begin;

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
  select * into a from relay.attachments where id = p_id and status <> 'pending';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  -- 一對一與自己上傳的：同租戶才行（和原本一樣）
  if a.tenant_id is not distinct from v_t then
    if a.owner_node = p_node then
      v_ok := true;
    elsif a.message_id is not null then
      v_ok := exists (
        select 1 from relay.messages m
        where m.id = a.message_id
          and (m.to_node = p_node
            or (m.fanout_id is not null and exists (select 1 from relay.messages c where c.fanout_id = m.fanout_id and c.to_node = p_node))
            or (m.person_user is not null and exists (select 1 from relay.nodes pn where pn.id = p_node and pn.owner_user = m.person_user))));
    end if;
  end if;
  -- 群組附件：群組現有成員的設備（跨租戶也行）
  if not v_ok and a.message_id is null and a.room_id is not null and v_t is not null then
    v_ok := exists (select 1 from relay.room_members rm
      where rm.room_id = a.room_id and rm.left_at is null and split_part(rm.member, '~', 1) = p_node)
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
