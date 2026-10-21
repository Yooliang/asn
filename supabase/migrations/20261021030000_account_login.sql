-- 登入與認領（第一期，見 docs/AUTH.md、docs/design/ONBOARDING.md）：
-- 每個登入帳號一個租戶（D3）；帳號可為「這台新電腦」建節點並拿到一把新金鑰，或用現有節點金鑰把節點認領到自己名下。
-- 所有資料表只給後端用（RLS 全開、不建 policy）；所有函式只授權 service_role，身分（p_user）由 Edge Function 驗過登入憑證後帶入。
-- 回復做法：supabase/sql/rollback/20261021030000_account_login_down.sql
begin;

alter table relay.nodes
  add column device_id text,
  add column created_via text;
alter table relay.nodes add constraint nodes_device_id_check
  check (device_id is null or device_id ~ '^[A-Za-z0-9_-]{16,64}$');
alter table relay.nodes add constraint nodes_created_via_check
  check (created_via is null or created_via in ('login-device', 'claim-existing'));
-- 同一個帳號下，同一個 device_id 只有一個節點（重裝或回應遺失時，重送就是換新金鑰，而不是多出一個節點）
create unique index nodes_owner_device_key on relay.nodes (owner_user, device_id) where device_id is not null;

-- 稽核（不含金鑰）
create table relay.account_events (
  id bigint generated always as identity,
  at timestamptz not null default now(),
  user_id uuid,
  event text not null,
  node text,
  detail jsonb,
  constraint account_events_pkey primary key (id)
);
create index account_events_user_idx on relay.account_events (user_id, at);
alter table relay.account_events enable row level security;
revoke all on relay.account_events from public, anon, authenticated;

-- 內部：確保這個帳號有自己的租戶（沒有就建，代號前綴 t<序號>-）
create or replace function relay.asn_ensure_tenant(p_user uuid, p_name text)
 returns relay.tenants
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_t relay.tenants%rowtype;
  v_serial integer;
  v_name text := left(coalesce(nullif(btrim(p_name), ''), '朋友'), 40);
begin
  select * into v_t from relay.tenants where owner_user = p_user;
  if found then
    return v_t;
  end if;
  loop
    v_serial := nextval('relay.tenant_serial');
    exit when not exists (select 1 from relay.tenants where serial = v_serial);
  end loop;
  insert into relay.tenants (serial, owner_user, id_prefix, owner_name)
    values (v_serial, p_user, 't' || v_serial || '-', v_name)
    on conflict (owner_user) do nothing;
  select * into v_t from relay.tenants where owner_user = p_user;
  insert into relay.account_events (user_id, event, detail)
    values (p_user, 'tenant_created', jsonb_build_object('serial', v_t.serial));
  return v_t;
end;
$function$;
revoke all on function relay.asn_ensure_tenant(uuid, text) from public, anon, authenticated;

-- 名下節點（不含金鑰、不含金鑰雜湊）
create or replace function relay.asn_account_nodes(p_user uuid)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id, 'name', n.name, 'machine', n.machine, 'kind', n.kind,
    'last_seen_at', n.last_seen_at, 'created_via', n.created_via) order by n.created_at), '[]'::jsonb)
  from relay.nodes n where n.owner_user = p_user and n.status = 'active';
$function$;
revoke all on function relay.asn_account_nodes(uuid) from public, anon, authenticated;

-- 第一次登入：建立租戶（已有就直接用），回傳帳號資訊與名下節點
create or replace function public.asn_account_bootstrap(p_user uuid, p_email text, p_name text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_t relay.tenants%rowtype;
  v_existed boolean;
begin
  v_existed := exists (select 1 from relay.tenants where owner_user = p_user);
  v_t := relay.asn_ensure_tenant(p_user, coalesce(nullif(btrim(p_name), ''), split_part(coalesce(p_email, ''), '@', 1)));
  return jsonb_build_object(
    'created', not v_existed,
    'user', jsonb_build_object('id', p_user, 'email', p_email),
    'tenant', jsonb_build_object('serial', v_t.serial, 'owner_name', v_t.owner_name, 'status', v_t.status),
    'nodes', relay.asn_account_nodes(p_user));
end;
$function$;
revoke all on function public.asn_account_bootstrap(uuid, text, text) from public, anon, authenticated;
grant execute on function public.asn_account_bootstrap(uuid, text, text) to service_role;

-- 認領現有節點：以「這台電腦目前的節點金鑰」（雜湊）證明擁有。
-- 只有尚未被認領、且在自己租戶底下的節點可認領；金鑰與代號都不變，歷史信件不斷。
-- 節點在別人的租戶、或在還沒被認領的舊租戶：回 tenant_not_yours（舊租戶要先由管理者執行 asn_admin_adopt_tenant）。
create or replace function public.asn_node_claim(p_user uuid, p_key_hash text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_n relay.nodes%rowtype;
  v_t relay.tenants%rowtype;
begin
  select * into v_n from relay.nodes where key_hash = p_key_hash and status = 'active' for update;
  if not found then
    return jsonb_build_object('error', 'invalid_key');
  end if;
  if v_n.owner_user = p_user then
    return jsonb_build_object('ok', true, 'already', true, 'node', v_n.id);
  end if;
  if v_n.owner_user is not null then
    return jsonb_build_object('error', 'already_claimed');
  end if;
  select * into v_t from relay.tenants where id = v_n.tenant_id;
  if not found or v_t.status <> 'active' or v_t.owner_user is distinct from p_user then
    return jsonb_build_object('error', 'tenant_not_yours');
  end if;
  update relay.nodes set owner_user = p_user, created_via = coalesce(created_via, 'claim-existing') where id = v_n.id;
  insert into relay.account_events (user_id, event, node) values (p_user, 'node_claimed', v_n.id);
  return jsonb_build_object('ok', true, 'already', false, 'node', v_n.id);
end;
$function$;
revoke all on function public.asn_node_claim(uuid, text) from public, anon, authenticated;
grant execute on function public.asn_node_claim(uuid, text) to service_role;

-- 替這台新電腦建節點。金鑰與門鈴頻道由 Edge Function 產生，這裡只收金鑰雜湊（金鑰本身不進資料庫、也不進稽核）。
-- 同一個帳號、同一個 device_id 重送＝換新金鑰（舊金鑰立即失效）。每個帳號最多 20 個節點。
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

-- 一次性管理流程：讓指定 email 的帳號認領舊租戶（預設序號 1，也就是現有 16 個節點所在的租戶）。
-- 由管理者在 SQL 編輯器執行：select public.asn_admin_adopt_tenant('小良哥的 email');
-- 該帳號若已經在登入時自動建了一個空租戶，會先刪掉它（有節點就拒絕，避免誤刪）；舊租戶底下沒有主人的節點一併掛到此帳號。
create or replace function public.asn_admin_adopt_tenant(p_email text, p_serial integer default 1)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_user uuid;
  v_t relay.tenants%rowtype;
  v_own relay.tenants%rowtype;
  v_cnt int;
begin
  select id into v_user from auth.users where lower(email) = lower(btrim(p_email)) order by created_at limit 1;
  if v_user is null then
    return jsonb_build_object('error', 'user_not_found');
  end if;
  select * into v_t from relay.tenants where serial = p_serial for update;
  if not found then
    return jsonb_build_object('error', 'tenant_not_found');
  end if;
  if v_t.owner_user is not null and v_t.owner_user <> v_user then
    return jsonb_build_object('error', 'tenant_owned');
  end if;
  select * into v_own from relay.tenants where owner_user = v_user and id <> v_t.id;
  if found then
    if exists (select 1 from relay.nodes where tenant_id = v_own.id) then
      return jsonb_build_object('error', 'user_has_nodes');
    end if;
    delete from relay.tenants where id = v_own.id;
  end if;
  update relay.tenants set owner_user = v_user where id = v_t.id;
  update relay.nodes set owner_user = v_user, created_via = coalesce(created_via, 'claim-existing')
    where tenant_id = v_t.id and owner_user is null and status = 'active';
  get diagnostics v_cnt = row_count;
  insert into relay.account_events (user_id, event, detail)
    values (v_user, 'tenant_adopted', jsonb_build_object('serial', v_t.serial, 'nodes', v_cnt));
  return jsonb_build_object('ok', true, 'tenant_serial', v_t.serial, 'nodes_claimed', v_cnt, 'user', v_user);
end;
$function$;
revoke all on function public.asn_admin_adopt_tenant(text, integer) from public, anon, authenticated;
grant execute on function public.asn_admin_adopt_tenant(text, integer) to service_role;

commit;
