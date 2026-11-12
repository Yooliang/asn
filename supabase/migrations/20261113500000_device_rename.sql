-- 設備名稱統一（#1388，0.2.18）：每台設備（電腦、手機、雲端代理）只有一個名字＝relay.nodes.name，所有地方顯示同一個值。
-- 做三件事：
--   1. relay.nodes 加 name_by_owner：本人改過名就是 true。
--   2. 新函式 asn_device_rename(p_user, p_actor, p_node, p_name)：本人從任一台自己的設備替任一台自己的設備改名。
--      身分由 Edge Function 驗過節點金鑰（p_actor）與帳號簽章（p_user）後帶入；這裡再核對 actor 與要改的那台都是這個人的、啟用中。
--      名字規則：去頭尾空白、1～40 字、不含控制字元、不含零寬與雙向控制字元、不含「指紋」、不含像指紋的字樣（連續 8 個十六進位字且其中有數字，或「4 碼 空白 4 碼」且其中有數字）。
--      同步群組裡整台設備當成員且顯示名等於舊名的那幾列（同 asn_cloud_node_rename）；寫一筆 account_events（device_renamed）。
--      同一個帳號 60 秒內最多改 10 次，超過回 rate_limited。
--   3. asn_relay_set_self_name（ASN 啟動時用節點金鑰寫自己的名字）：本人改過名（name_by_owner）就不覆蓋，回 ok 並帶 kept=true，
--      舊版用戶端每次啟動照送也不會把名字蓋回去。asn_cloud_node_rename 改名時也設 name_by_owner。
--   4. 其他會寫 nodes.name 的地方也看 name_by_owner：asn_node_create（同一台重新登入）、asn_relay_update（舊後台 update 動作）。
-- security definer 函式碰到的資料表：relay.nodes、relay.tenants（asn_user_owns_node）、relay.room_members、relay.account_events。
-- 全部 set search_path to ''，只授權 service_role。
-- 部署順序：本 migration → relay（device_rename 動作）→ 0.2.18 用戶端。提早上不會壞：舊版沒有改名入口，set_name 在沒改過名時行為不變。
-- 回復：supabase/sql/rollback/20261113500000_device_rename_down.sql。
begin;

alter table relay.nodes add column if not exists name_by_owner boolean not null default false;

-- 名字規則（改名專用；set_self_name 照舊只用前三條，收緊另開一張）
create or replace function relay.device_name_ok(p_name text)
 returns boolean language sql immutable set search_path to ''
as $function$
  select p_name is not null
     and char_length(p_name) between 1 and 40
     and p_name !~ '[[:cntrl:]]'
     and p_name !~ '[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]'
     and position('指紋' in p_name) = 0
     and p_name !~* '(?=[a-f]{0,7}[0-9])[0-9a-f]{8}'
     and p_name !~* '(?=[a-f[:space:]　]{0,8}[0-9])[0-9a-f]{4}[[:space:]　][0-9a-f]{4}';
$function$;
revoke all on function relay.device_name_ok(text) from public, anon, authenticated;

create or replace function public.asn_device_rename(p_user uuid, p_actor text, p_node text, p_name text)
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
  if p_user is null or p_actor is null or p_node is null or not relay.device_name_ok(v_name) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 送請求的設備與要改的設備都要是這個人的、啟用中（別人的、撤銷的、不存在一律 not_found，不洩漏是哪一種）
  if not public.asn_user_owns_node(p_user, p_actor) or not public.asn_user_owns_node(p_user, p_node) then
    return jsonb_build_object('error', 'not_found');
  end if;
  select n.name into v_old from relay.nodes n where n.id = p_node and n.status = 'active' for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_old is not distinct from v_name then
    update relay.nodes set name_by_owner = true where id = p_node;
    return jsonb_build_object('ok', true, 'name', v_name, 'changed', false);
  end if;
  if (select count(*) from relay.account_events e
       where e.user_id = p_user and e.event = 'device_renamed' and e.at > now() - interval '60 seconds') >= 10 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  update relay.nodes set name = v_name, name_by_owner = true where id = p_node;
  update relay.room_members set display_name = v_name
   where member = p_node and display_name = v_old;
  get diagnostics v_rooms = row_count;
  insert into relay.account_events (user_id, event, node, detail)
    values (p_user, 'device_renamed', p_node, jsonb_build_object('from', v_old, 'to', v_name, 'by', p_actor, 'rooms', v_rooms));
  return jsonb_build_object('ok', true, 'name', v_name, 'changed', true);
end;
$function$;
revoke all on function public.asn_device_rename(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_device_rename(uuid, text, text, text) to service_role;

-- 節點自己寫名字（ASN 啟動時）：本人改過名就不覆蓋
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
  update relay.nodes set name = v_name where id = p_node and status = 'active' and not name_by_owner;
  if found then
    return jsonb_build_object('ok', true);
  end if;
  if exists (select 1 from relay.nodes where id = p_node and status = 'active') then
    return jsonb_build_object('ok', true, 'kept', true);
  end if;
  return jsonb_build_object('error', 'not_found');
end;
$function$;
revoke all on function public.asn_relay_set_self_name(text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_set_self_name(text, text) to service_role;

-- 雲端代理改名：改過也算本人取的名字
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
  update relay.nodes set name = v_name, name_by_owner = true where id = p_node;
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

-- 同一台重新登入（asn_node_create 同 device_id＝換新金鑰）：本人改過名就保留原名，不用登入時的視窗名蓋掉
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
    update relay.nodes set key_hash = p_key_hash, bell_topic = p_bell_topic, status = 'active', name = case when v_old.name_by_owner then v_old.name else v_name end, machine = v_machine, last_seen_at = now()
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

-- 舊後台的 update 動作（owner 角色節點改同租戶節點）：本人改過名就不改名字（machine 照舊可改）
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
  update relay.nodes set machine = coalesce(p_machine, machine), name = case when name_by_owner then name else coalesce(p_name, name) end
    where id = p_id and status = 'active' and tenant_id is not distinct from v_tenant;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;
revoke all on function public.asn_relay_update(text, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_update(text, text, text, text) to service_role;

commit;
