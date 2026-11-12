-- 回復 20261113500000_device_rename.sql：拿掉改名函式與名字規則，set_self_name、cloud_node_rename、node_create、relay_update 換回原文，拿掉 name_by_owner 欄位。
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

-- 換回原文（要在拿掉欄位之前）
create or replace function public.asn_node_create(p_user uuid, p_name text, p_machine text, p_device_id text, p_key_hash text, p_bell_topic text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_t relay.tenants%rowtype;
  v_old relay.nodes%rowtype;
  v_name text := btrim(p_name);
  v_machine text := btrim(p_machine);
  v_id text;
  v_tries int := 0;
begin
  if v_name is null or char_length(v_name) not between 1 and 40 or v_name ~ '[[:cntrl:]]'
     or v_machine is null or char_length(v_machine) not between 1 and 40 or v_machine ~ '[[:cntrl:]]'
     or p_device_id is null or p_device_id !~ '^[A-Za-z0-9_-]{16,64}$'
     or p_key_hash is null or p_bell_topic is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  v_t := relay.asn_ensure_tenant(p_user, null);
  if v_t.status <> 'active' then
    return jsonb_build_object('error', 'tenant_inactive');
  end if;

  select * into v_old from relay.nodes where owner_user = p_user and device_id = p_device_id for update;
  if found then
    update relay.nodes set key_hash = p_key_hash, bell_topic = p_bell_topic, status = 'active', name = v_name, machine = v_machine, last_seen_at = now()
      where id = v_old.id;
    insert into relay.account_events (user_id, event, node, detail) values (p_user, 'node_rekeyed', v_old.id, jsonb_build_object('via', 'device_id'));
    return jsonb_build_object('id', v_old.id, 'bell_topic', p_bell_topic, 'rotated', true);
  end if;

  if (select count(*) from relay.nodes where owner_user = p_user and status = 'active') >= 20 then
    return jsonb_build_object('error', 'too_many');
  end if;

  loop
    -- 有前綴的租戶用 t<序號>-；舊租戶（沒前綴）用 n 開頭，避開「t<數字>-」開頭的保留格式
    v_id := coalesce(v_t.id_prefix, 'n') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
    begin
      insert into relay.nodes (id, name, key_hash, bell_topic, kind, role, can_invite, machine, status, last_seen_at, tenant_id, owner_user, device_id, created_via)
        values (v_id, v_name, p_key_hash, p_bell_topic, 'other', 'member', false, v_machine, 'active', now(), v_t.id, p_user, p_device_id, 'login-device');
      exit;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries >= 5 then
        return jsonb_build_object('error', 'internal');
      end if;
    end;
  end loop;
  insert into relay.account_events (user_id, event, node) values (p_user, 'node_created', v_id);
  return jsonb_build_object('id', v_id, 'bell_topic', p_bell_topic, 'rotated', false);
end;
$function$;
revoke all on function public.asn_node_create(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_node_create(uuid, text, text, text, text, text) to service_role;

CREATE OR REPLACE FUNCTION public.asn_relay_update(p_node text, p_id text, p_machine text, p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from relay.nodes where id = p_node and role = 'owner' and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if (p_machine is not null and char_length(p_machine) not between 1 and 40)
     or (p_name is not null and char_length(p_name) not between 1 and 100)
     or (p_machine is null and p_name is null) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.nodes set machine = coalesce(p_machine, machine), name = coalesce(p_name, name)
    where id = p_id and status = 'active' and tenant_id is not distinct from v_tenant;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;
revoke all on function public.asn_relay_update(text, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_update(text, text, text, text) to service_role;

alter table relay.nodes drop column if exists name_by_owner;

commit;
