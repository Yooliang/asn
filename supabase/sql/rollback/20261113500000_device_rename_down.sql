-- 回復 20261113500000_device_rename.sql：拿掉改名函式與名字規則，set_self_name 與 cloud_node_rename 換回原文，拿掉 name_by_owner 欄位。
-- 已經改過的名字保留在 nodes.name（之後舊的 set_name 會照舊用視窗名蓋掉）；account_events 紀錄保留。
begin;

drop function if exists public.asn_device_rename(uuid, text, text, text);
drop function if exists relay.device_name_ok(text);

create or replace function public.asn_relay_set_self_name(p_node text, p_name text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_name text := btrim(p_name);
begin
  if v_name is null or char_length(v_name) not between 1 and 40 or v_name ~ '[[:cntrl:]]' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.nodes set name = v_name where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;
revoke all on function public.asn_relay_set_self_name(text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_set_self_name(text, text) to service_role;

create or replace function public.asn_cloud_node_rename(p_user uuid, p_node text, p_name text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_name text := btrim(p_name);
  v_old text;
  v_rooms int := 0;
begin
  if p_user is null or p_node is null or v_name is null or char_length(v_name) not between 1 and 40 or v_name ~ '[[:cntrl:]]' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select n.name into v_old from relay.nodes n
   where n.id = p_node and n.owner_user = p_user and n.status = 'active' and n.created_via = 'cloud-invite'
   for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_old is not distinct from v_name then
    return jsonb_build_object('ok', true, 'name', v_name, 'changed', false);
  end if;
  update relay.nodes set name = v_name where id = p_node;
  update relay.room_members set display_name = v_name
   where member = p_node and display_name = v_old;
  get diagnostics v_rooms = row_count;
  insert into relay.account_events (user_id, event, node, detail)
    values (p_user, 'cloud_node_renamed', p_node, jsonb_build_object('from', v_old, 'to', v_name, 'rooms', v_rooms));
  return jsonb_build_object('ok', true, 'name', v_name, 'changed', true);
end;
$function$;
revoke all on function public.asn_cloud_node_rename(uuid, text, text) from public, anon, authenticated;
grant execute on function public.asn_cloud_node_rename(uuid, text, text) to service_role;

alter table relay.nodes drop column if exists name_by_owner;

commit;
