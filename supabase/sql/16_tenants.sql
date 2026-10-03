-- 16_tenants.sql：多使用者第一期 A 段（設計見 docs/MULTI-USER.md；本輪做了什麼見 docs/MULTI-USER-PHASE1.md）。
-- 內容：
--   1. relay.tenants（租戶）、irori.accounts（帳號白名單，取代 IRORI_OWNER_EMAILS）、irori.account_invites（邀請碼）。
--   2. relay.nodes／messages／invites／rooms／launches 加 tenant_id，並把現有資料全部回填成「租戶 1」（小良哥的 XISU、H、w02、aegis、群組…）。
--   3. 仲介函式全部改成租戶感知：寄信、名單、邀請、群組、遠端開視窗都只看得到自己租戶的東西；跨租戶一律回「找不到」。
--   4. 帳號／租戶函式：登入時解析帳號（第一次登入自動開租戶與角色節點、送額度）、邀請、停用、列表。
-- 執行方式：npx supabase db query --linked -f supabase/sql/16_tenants.sql（可重複執行；只新增、不刪任何既有資料；先於 irori-relay／irori-api 部署）。
-- 接著確認回填無誤，再跑 17_tenants_enforce.sql 加上 NOT NULL 與複合外鍵（由資料庫保證信不能跨租戶）。
-- 回退見 supabase/sql/rollback/16_tenants_down.sql。
-- 權限設計延續 01～15：relay／irori schema 不暴露 PostgREST；表 enable RLS 不建 policy；
-- 存取只走 public.irori_* SECURITY DEFINER 函式，只授權 service_role。

create schema if not exists relay;
create schema if not exists irori;

-- ── 1. 租戶與帳號 ──

create sequence if not exists relay.tenant_serial;

-- 租戶：一位使用者的一整套。character_node＝角色節點（希緒），每租戶恰好一個；
-- id_prefix：這個租戶底下新節點的代號必須以它開頭（租戶 1 為 null＝不限，保持舊行為），避免佔用全域代號；
-- owner_name：租戶主人的稱呼（群組裡「~owner」成員的顯示名；由 settings.user_name 同步）
create table if not exists relay.tenants (
  id uuid primary key default gen_random_uuid(),
  serial integer not null unique default nextval('relay.tenant_serial'),
  owner_user uuid unique,
  character_node text,
  id_prefix text,
  owner_name text not null default '朋友',
  status text not null default 'active' check (status in ('active', 'suspended', 'deleting')),
  features jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table relay.tenants enable row level security;
revoke all on relay.tenants from public, anon, authenticated;

-- 帳號白名單：誰能登入。email 一律小寫；user_id 第一次登入才填；role＝admin（管理者）／member；
-- status＝active／suspended（停用：登入回 403，機器橋金鑰暫時失效）；source＝env（IRORI_OWNER_EMAILS）／invite／manual／legacy
create table if not exists irori.accounts (
  email text primary key check (email = lower(btrim(email)) and email <> ''),
  user_id uuid unique,
  tenant_id uuid references relay.tenants(id),
  role text not null default 'member' check (role in ('admin', 'member')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  source text not null default 'invite' check (source in ('env', 'invite', 'manual', 'legacy')),
  invited_by uuid,
  invite_id uuid,
  note text,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  last_login_at timestamptz
);
alter table irori.accounts enable row level security;
revoke all on irori.accounts from public, anon, authenticated;

-- 邀請：一次性、有期限、只存雜湊。email 有填＝只有這個信箱能用（對方用該 Google 帳號登入時自動開通，不必貼碼）；
-- 沒填＝誰拿到碼都能兌換一次（管理者把連結交給對方）
create table if not exists irori.account_invites (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  email text check (email is null or email = lower(btrim(email))),
  role text not null default 'member' check (role in ('admin', 'member')),
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid,
  revoked_at timestamptz
);
alter table irori.account_invites enable row level security;
revoke all on irori.account_invites from public, anon, authenticated;
create index if not exists account_invites_email_idx on irori.account_invites (email) where used_at is null and revoked_at is null;

-- ── 2. 既有表加 tenant_id（先可為 null，回填後由 17_tenants_enforce.sql 設 NOT NULL 與複合外鍵）──

alter table relay.nodes add column if not exists tenant_id uuid references relay.tenants(id);
alter table relay.messages add column if not exists tenant_id uuid references relay.tenants(id);
alter table relay.invites add column if not exists tenant_id uuid references relay.tenants(id);
alter table relay.rooms add column if not exists tenant_id uuid references relay.tenants(id);
alter table relay.launches add column if not exists tenant_id uuid references relay.tenants(id);
create index if not exists nodes_tenant_idx on relay.nodes (tenant_id);
create index if not exists rooms_tenant_idx on relay.rooms (tenant_id);
create index if not exists launches_tenant_idx on relay.launches (tenant_id);

-- ── 3. 租戶 1：小良哥現有的一切原地變成租戶 1（不搬資料、不改金鑰）──

do $$
declare
  c_t1 constant uuid := '00000000-0000-0000-0000-000000000001';
  v_n int;
  v_owner uuid;
  v_char text;
  v_name text;
  v_email text;
begin
  if not exists (select 1 from relay.tenants where id = c_t1) then
    -- 舊資料的擁有者：irori.kv 的 state 只有一位 owner 時就是他；有多位（不確定是誰）就先留空，之後手動 select public.irori_tenant_claim_legacy('<email>')
    select count(distinct owner), (array_agg(owner))[1] into v_n, v_owner from irori.kv where key = 'state';
    if v_n <> 1 then v_owner := null; end if;
    select id into v_char from relay.nodes where role = 'owner' and status = 'active' order by created_at, id limit 1;
    select nullif(btrim(value #>> '{settings,user_name}'), '') into v_name from irori.kv where owner = v_owner and key = 'state';
    insert into relay.tenants (id, serial, owner_user, character_node, id_prefix, owner_name)
      values (c_t1, 1, v_owner, v_char, null, coalesce(v_name, '朋友'));
  end if;
  perform setval('relay.tenant_serial', greatest((select max(serial) from relay.tenants), 1), true);

  update relay.nodes set tenant_id = c_t1 where tenant_id is null;
  update relay.messages m set tenant_id = n.tenant_id from relay.nodes n where n.id = m.from_node and m.tenant_id is null;
  update relay.invites i set tenant_id = n.tenant_id from relay.nodes n where n.id = i.created_by and i.tenant_id is null;
  update relay.rooms r set tenant_id = n.tenant_id from relay.nodes n where n.id = r.created_by and r.tenant_id is null;
  update relay.rooms set tenant_id = c_t1 where tenant_id is null;
  update relay.launches l set tenant_id = n.tenant_id from relay.nodes n where n.id = l.requested_by and l.tenant_id is null;

  -- 租戶 1 的主人也進白名單（email 取自 Supabase Auth）；沒有 auth.users（自架環境）就跳過，等他第一次登入再建
  select owner_user into v_owner from relay.tenants where id = c_t1;
  if v_owner is not null and to_regclass('auth.users') is not null then
    execute 'select lower(btrim(email)) from auth.users where id = $1' into v_email using v_owner;
    if v_email is not null and v_email <> '' then
      insert into irori.accounts (email, user_id, tenant_id, role, status, source, activated_at)
        values (v_email, v_owner, c_t1, 'admin', 'active', 'legacy', now())
        on conflict (email) do nothing;
    end if;
  end if;
end $$;

-- ── 4. 內部小工具與租戶函式 ──

create or replace function relay.node_tenant(p_node text)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select tenant_id from relay.nodes where id = p_node;
$$;

-- 租戶 1 的認領（舊資料的擁有者登入時，或上線時手動補）
create or replace function public.irori_tenant_claim_legacy(p_email text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  c_t1 constant uuid := '00000000-0000-0000-0000-000000000001';
  v_uid uuid;
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if to_regclass('auth.users') is null then
    return jsonb_build_object('error', 'no_auth_users');
  end if;
  execute 'select id from auth.users where lower(email) = $1 limit 1' into v_uid using v_email;
  if v_uid is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  update relay.tenants set owner_user = v_uid where id = c_t1 and (owner_user is null or owner_user = v_uid);
  if not found then
    return jsonb_build_object('error', 'already_claimed');
  end if;
  insert into irori.accounts (email, user_id, tenant_id, role, status, source, activated_at)
    values (v_email, v_uid, c_t1, 'admin', 'active', 'legacy', now())
    on conflict (email) do update set user_id = excluded.user_id, tenant_id = c_t1, role = 'admin', status = 'active';
  return jsonb_build_object('ok', true, 'user_id', v_uid);
end;
$$;

-- 開一個新租戶：租戶列＋角色節點（希緒，role=owner，不產生金鑰——irori-api 直接用 RPC 以它的身分動作）＋預設狀態（稱呼取自 Google 顯示名）。
-- 同一個使用者重複呼叫回同一個租戶（冪等）
create or replace function public.irori_tenant_provision(p_uid uuid, p_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_serial int;
  v_prefix text;
  v_node text;
  v_user text := left(btrim(split_part(btrim(coalesce(p_name, '')), ' ', 1)), 12);
begin
  if p_uid is null then
    raise exception 'uid required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('irori_tenant:' || p_uid::text, 0));
  select id into v_id from relay.tenants where owner_user = p_uid;
  if found then
    return v_id;
  end if;
  if v_user = '' then v_user := '朋友'; end if;
  insert into relay.tenants (owner_user, owner_name) values (p_uid, v_user) returning id, serial into v_id, v_serial;
  v_prefix := 't' || v_serial || '-';
  v_node := v_prefix || 'xisu';
  insert into relay.nodes (id, name, key_hash, bell_topic, kind, role, can_invite, machine, status, tenant_id, last_seen_at)
    values (v_node, '希緒', 'nokey:' || gen_random_uuid()::text, 'relay-bell-' || replace(gen_random_uuid()::text, '-', ''),
            'other', 'owner', false, '雲端', 'active', v_id, now());
  update relay.tenants set id_prefix = v_prefix, character_node = v_node where id = v_id;
  insert into irori.kv (owner, key, value)
    values (p_uid, 'state', jsonb_build_object('settings', jsonb_build_object('user_name', v_user)))
    on conflict (owner, key) do nothing;
  return v_id;
end;
$$;

-- 這個使用者的租戶（irori-api 在快取過期時用）
create or replace function public.irori_tenant_of_user(p_user uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select jsonb_build_object('tenant_id', t.id, 'serial', t.serial, 'node', t.character_node, 'status', t.status,
                              'owner_name', t.owner_name, 'features', t.features, 'bell_topic', n.bell_topic)
    from relay.tenants t left join relay.nodes n on n.id = t.character_node
    where t.owner_user = p_user
  ), 'null'::jsonb);
$$;

-- 角色節點的身分（whoami）：節點代號與來信門鈴頻道
create or replace function public.irori_relay_whoami(p_tenant uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select jsonb_build_object('node', n.id, 'bell_topic', n.bell_topic)
    from relay.tenants t join relay.nodes n on n.id = t.character_node and n.status = 'active'
    where t.id = p_tenant
  ), 'null'::jsonb);
$$;

-- 主人的稱呼（settings.user_name）同步到租戶：群組裡「~owner」成員的顯示名用它。沒有租戶的使用者什麼都不做
create or replace function public.irori_tenant_set_owner_name(p_user uuid, p_name text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_name text := left(btrim(coalesce(p_name, '')), 12);
begin
  if v_name = '' then return false; end if;
  update relay.tenants set owner_name = v_name where owner_user = p_user and owner_name is distinct from v_name;
  return found;
end;
$$;

-- ── 5. 帳號：登入解析、邀請、兌換、停用、列表 ──

-- 帳號與租戶的檢視（給 irori-api）
create or replace function relay.account_view(p_email text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'status', case when a.status = 'suspended' or coalesce(t.status, 'active') <> 'active' then 'suspended' else 'active' end,
    'email', a.email, 'user_id', a.user_id, 'role', a.role, 'source', a.source,
    'tenant_id', a.tenant_id, 'serial', t.serial, 'node', t.character_node, 'owner_name', t.owner_name,
    'features', coalesce(t.features, '{}'::jsonb), 'bell_topic', n.bell_topic)
  from irori.accounts a
  left join relay.tenants t on t.id = a.tenant_id
  left join relay.nodes n on n.id = t.character_node
  where a.email = p_email;
$$;

-- 登入時解析帳號（每次驗過 token 後呼叫）：
--   有帳號＝回帳號與租戶（沒有租戶就補開）；停用＝suspended；
--   沒帳號：email 在 IRORI_OWNER_EMAILS（p_env_admin）＝自動建管理者帳號；有未過期的、綁這個 email 的邀請＝自動開通；其他＝none。
--   新帳號當場建租戶與角色節點，並建立額度列（送 p_free 美元；管理者無上限）。同一個 Google 帳號只有一列額度＝只送一次。
create or replace function public.irori_account_resolve(p_uid uuid, p_email text, p_name text, p_env_admin boolean, p_free numeric)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  c_t1 constant uuid := '00000000-0000-0000-0000-000000000001';
  v_email text := lower(btrim(coalesce(p_email, '')));
  a irori.accounts%rowtype;
  v_inv irori.account_invites%rowtype;
  v_t1 relay.tenants%rowtype;
  v_tenant uuid;
  v_role text;
  v_new boolean := false;
begin
  if p_uid is null or v_email = '' then
    return jsonb_build_object('status', 'none');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('irori_account:' || p_uid::text, 0));
  select * into a from irori.accounts where user_id = p_uid;
  if not found then
    select * into a from irori.accounts where email = v_email;
    -- 同一個 email 但已綁在另一個登入身分上（例如 Google 帳號重建過）：不自動接手，請管理者處理
    if found and a.user_id is not null and a.user_id <> p_uid then
      return jsonb_build_object('status', 'none');
    end if;
  end if;

  if found then
    if a.status = 'suspended' and not coalesce(p_env_admin, false) then
      return jsonb_build_object('status', 'suspended');
    end if;
    if a.user_id is null then
      update irori.accounts set user_id = p_uid, activated_at = coalesce(activated_at, now()) where email = a.email;
    end if;
    if coalesce(p_env_admin, false) and (a.role <> 'admin' or a.status <> 'active') then
      update irori.accounts set role = 'admin', status = 'active' where email = a.email;
      update relay.tenants set status = 'active' where id = a.tenant_id and status = 'suspended';
    end if;
    if a.tenant_id is null then
      v_tenant := public.irori_tenant_provision(p_uid, p_name);
      update irori.accounts set tenant_id = v_tenant where email = a.email;
      v_new := true;
    end if;
    update irori.accounts set last_login_at = now()
      where email = a.email and (last_login_at is null or last_login_at < now() - interval '10 minutes');
  else
    if coalesce(p_env_admin, false) then
      v_role := 'admin';
    else
      select * into v_inv from irori.account_invites
        where email = v_email and used_at is null and revoked_at is null and expires_at > now()
        order by created_at desc limit 1 for update;
      if not found then
        return jsonb_build_object('status', 'none');
      end if;
      v_role := v_inv.role;
    end if;
    -- 舊資料的擁有者第一次用新流程登入：認領租戶 1（只限租戶 1 還沒人認領，且他確實有舊狀態資料）
    select * into v_t1 from relay.tenants where id = c_t1 for update;
    if found and v_t1.owner_user is null and exists (select 1 from irori.kv where owner = p_uid and key = 'state') then
      update relay.tenants set owner_user = p_uid where id = c_t1;
      v_tenant := c_t1;
    else
      v_tenant := public.irori_tenant_provision(p_uid, p_name);
    end if;
    insert into irori.accounts (email, user_id, tenant_id, role, status, source, invited_by, invite_id, activated_at, last_login_at)
      values (v_email, p_uid, v_tenant, v_role, 'active', case when coalesce(p_env_admin, false) then 'env' else 'invite' end,
              v_inv.created_by, v_inv.id, now(), now());
    if v_inv.id is not null then
      update irori.account_invites set used_at = now(), used_by = p_uid where id = v_inv.id;
    end if;
    v_new := true;
  end if;

  -- 額度列：沒有就建立（送 p_free 美元；管理者無上限）。15_usage.sql 還沒套用時略過
  begin
    perform public.irori_usage_status(p_uid, p_free, coalesce((select role = 'admin' from irori.accounts where email = coalesce(a.email, v_email)), false));
  exception when undefined_function then null;
  end;
  return relay.account_view(coalesce(a.email, v_email)) || jsonb_build_object('new', v_new);
end;
$$;

-- 管理者建邀請（API 端已確認呼叫者是管理者）。p_email 有填＝綁定該信箱。同一個信箱已有現役帳號回 already_member
create or replace function public.irori_account_invite_create(
  p_by uuid, p_email text, p_code_hash text, p_role text, p_note text, p_ttl_hours integer
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_id uuid;
  v_exp timestamptz;
begin
  if p_code_hash is null or p_code_hash = '' or p_role not in ('admin', 'member') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if v_email is not null and exists (select 1 from irori.accounts where email = v_email) then
    return jsonb_build_object('error', 'already_member');
  end if;
  delete from irori.account_invites
    where (used_at is not null or revoked_at is not null or expires_at < now()) and created_at < now() - interval '30 days';
  -- 同一個信箱只留一張有效的邀請：舊的作廢
  if v_email is not null then
    update irori.account_invites set revoked_at = now() where email = v_email and used_at is null and revoked_at is null;
  end if;
  v_exp := now() + make_interval(hours => least(greatest(coalesce(p_ttl_hours, 168), 1), 24 * 30));
  insert into irori.account_invites (code_hash, email, role, note, created_by, expires_at)
    values (p_code_hash, v_email, p_role, left(p_note, 200), p_by, v_exp)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'expires_at', v_exp);
end;
$$;

create or replace function public.irori_account_invite_revoke(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  update irori.account_invites set revoked_at = now() where id = p_id and used_at is null and revoked_at is null;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- 兌換邀請碼（登入後貼碼或點邀請連結）：碼要有效；綁信箱的邀請只有該信箱能兌換。兌換後開租戶、送額度
create or replace function public.irori_account_redeem(p_uid uuid, p_email text, p_name text, p_code_hash text, p_free numeric)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  c_t1 constant uuid := '00000000-0000-0000-0000-000000000001';
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_inv irori.account_invites%rowtype;
  v_exist irori.accounts%rowtype;
  v_tenant uuid;
  v_t1 relay.tenants%rowtype;
begin
  if p_uid is null or v_email = '' or p_code_hash is null then
    return jsonb_build_object('error', 'invalid_invite');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('irori_account:' || p_uid::text, 0));
  select * into v_exist from irori.accounts where user_id = p_uid or email = v_email limit 1;
  if found and v_exist.status = 'active' then
    return jsonb_build_object('error', 'already_member');
  end if;
  if found and v_exist.status = 'suspended' then
    return jsonb_build_object('error', 'suspended');
  end if;
  select * into v_inv from irori.account_invites where code_hash = p_code_hash for update;
  if not found or v_inv.used_at is not null or v_inv.revoked_at is not null or v_inv.expires_at < now() then
    return jsonb_build_object('error', 'invalid_invite');
  end if;
  if v_inv.email is not null and v_inv.email <> v_email then
    return jsonb_build_object('error', 'email_mismatch');
  end if;
  select * into v_t1 from relay.tenants where id = c_t1 for update;
  if found and v_t1.owner_user is null and exists (select 1 from irori.kv where owner = p_uid and key = 'state') then
    update relay.tenants set owner_user = p_uid where id = c_t1;
    v_tenant := c_t1;
  else
    v_tenant := public.irori_tenant_provision(p_uid, p_name);
  end if;
  insert into irori.accounts (email, user_id, tenant_id, role, status, source, invited_by, invite_id, activated_at, last_login_at)
    values (v_email, p_uid, v_tenant, v_inv.role, 'active', 'invite', v_inv.created_by, v_inv.id, now(), now());
  update irori.account_invites set used_at = now(), used_by = p_uid where id = v_inv.id;
  begin
    perform public.irori_usage_status(p_uid, p_free, v_inv.role = 'admin');
  exception when undefined_function then null;
  end;
  return relay.account_view(v_email) || jsonb_build_object('new', true);
end;
$$;

-- 停用／恢復帳號：連帶停用租戶（機器橋與 AI 夥伴的金鑰暫時失效；資料不動）。找不到回 not_found
create or replace function public.irori_account_set_status(p_email text, p_status text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  a irori.accounts%rowtype;
begin
  if p_status not in ('active', 'suspended') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select * into a from irori.accounts where email = v_email;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  update irori.accounts set status = p_status where email = v_email;
  if a.tenant_id is not null then
    update relay.tenants set status = case when p_status = 'active' then 'active' else 'suspended' end
      where id = a.tenant_id and status in ('active', 'suspended');
  end if;
  return jsonb_build_object('ok', true, 'user_id', a.user_id);
end;
$$;

-- 管理畫面用的列表：帳號（含租戶序號、機器數、額度）與還沒用掉的邀請。不含任何對話內容
create or replace function public.irori_account_list()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_acc jsonb; v_inv jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
      'email', a.email, 'user_id', a.user_id, 'role', a.role, 'status', a.status, 'source', a.source,
      'tenant', t.serial, 'owner_name', t.owner_name,
      'machines', (select count(*) from relay.nodes n where n.tenant_id = a.tenant_id and n.role = 'member' and n.status = 'active'),
      'created_at', a.created_at, 'last_login_at', a.last_login_at) order by a.created_at, a.email), '[]'::jsonb)
    into v_acc
    from irori.accounts a left join relay.tenants t on t.id = a.tenant_id;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'email', i.email, 'role', i.role, 'note', i.note, 'created_at', i.created_at, 'expires_at', i.expires_at)
      order by i.created_at desc), '[]'::jsonb)
    into v_inv from irori.account_invites i where i.used_at is null and i.revoked_at is null and i.expires_at > now();
  return jsonb_build_object('accounts', v_acc, 'invites', v_inv);
end;
$$;

-- ── 6. 仲介函式改成租戶感知 ──

-- 金鑰 → 節點。多回傳 tenant_id；租戶被停用（suspended）的節點金鑰暫時失效
drop function if exists public.irori_relay_auth(text);
create function public.irori_relay_auth(p_key_hash text)
returns table(id text, bell_topic text, role text, can_invite boolean, tenant_id uuid)
language sql security definer set search_path = ''
as $$
  update relay.nodes n set last_seen_at = now()
    where n.key_hash = p_key_hash and n.status = 'active'
      and (n.tenant_id is null or exists (select 1 from relay.tenants t where t.id = n.tenant_id and t.status = 'active'))
    returning n.id, n.bell_topic, n.role, n.can_invite, n.tenant_id;
$$;

-- 寄信：收件節點必須與寄件節點同租戶（不同租戶一律 unknown_to_node，跟「沒有這個節點」同樣的回應）。
-- 別名 XISU＝寄件者所屬租戶的角色節點（租戶 1 的角色節點本來就叫 XISU）。reply_to 也必須是同租戶的信
create or replace function public.irori_relay_send(
  p_from_node text, p_from_agent text, p_to_node text, p_to_agent text,
  p_body text, p_reply_to uuid
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_topic text;
  v_id uuid;
  v_recent int;
  v_tenant uuid;
  v_to text := p_to_node;
  v_char text;
begin
  if p_body is null or char_length(p_body) < 1 or char_length(p_body) > 20000 then
    return jsonb_build_object('error', 'bad_body');
  end if;
  select tenant_id into v_tenant from relay.nodes where id = p_from_node;
  if v_to = 'XISU' then
    select character_node into v_char from relay.tenants where id = v_tenant;
    if v_char is not null then v_to := v_char; end if;
  end if;
  select bell_topic into v_topic from relay.nodes
    where id = v_to and status = 'active' and tenant_id is not distinct from v_tenant;
  if v_topic is null then
    return jsonb_build_object('error', 'unknown_to_node');
  end if;
  select count(*) into v_recent from relay.messages
    where from_node = p_from_node and created_at > now() - interval '1 minute';
  if v_recent >= 30 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  if p_reply_to is not null and not exists (
    select 1 from relay.messages where id = p_reply_to and tenant_id is not distinct from v_tenant
  ) then
    p_reply_to := null;
  end if;
  insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id)
    values (p_from_node, p_from_agent, v_to, p_to_agent, p_body, p_reply_to, v_tenant)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$$;

-- 名單：只列這個租戶的現役節點。presence 規則同 02_members.sql
create or replace function public.irori_relay_list(p_tenant uuid)
returns jsonb
language sql security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id, 'name', n.name, 'kind', n.kind, 'machine', n.machine,
    'online', coalesce(n.last_seen_at > now() - interval '3 minutes', false),
    'presence', case when n.last_seen_at > now() - interval '3 minutes' then 'live'
                     when n.last_seen_at > now() - interval '24 hours' then 'recent' else 'idle' end,
    'last_seen_at', n.last_seen_at,
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', r.status, 'cwd_label', r.cwd_label) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at > now() - interval '3 minutes'
    ), '[]'::jsonb)) order by n.id), '[]'::jsonb)
  from relay.nodes n where n.status = 'active' and n.tenant_id is not distinct from p_tenant;
$$;

-- 以節點找租戶再列名單（群組自動收入用）
create or replace function public.irori_relay_list_by_node(p_node text)
returns jsonb
language sql security definer set search_path = ''
as $$
  select public.irori_relay_list(relay.node_tenant(p_node));
$$;

-- 舊的無參數版：只回租戶 1（過渡期舊版 irori-relay 還在跑時不致洩漏其他租戶；新版不再呼叫）
create or replace function public.irori_relay_list()
returns jsonb
language sql security definer set search_path = ''
as $$
  select public.irori_relay_list('00000000-0000-0000-0000-000000000001'::uuid);
$$;

-- 邀請：owner（角色節點）開邀請，代號前綴＝租戶的 id_prefix（租戶 1 不限）；can_invite 的機器節點限自己機器前綴。新邀請記下租戶
create or replace function public.irori_relay_invite(p_node text, p_code_hash text, p_note text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_me relay.nodes%rowtype;
  v_prefix text;
  v_exp timestamptz;
begin
  select * into v_me from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if v_me.role = 'owner' then
    select id_prefix into v_prefix from relay.tenants where id = v_me.tenant_id;
  elsif v_me.can_invite then
    v_prefix := split_part(v_me.id, '-', 1) || '-';
  else
    return jsonb_build_object('error', 'forbidden');
  end if;
  delete from relay.invites where expires_at < now() - interval '1 day';
  insert into relay.invites (code_hash, prefix, note, created_by, tenant_id)
    values (p_code_hash, v_prefix, left(p_note, 200), p_node, v_me.tenant_id)
    returning expires_at into v_exp;
  return jsonb_build_object('expires_at', v_exp, 'prefix', v_prefix);
end;
$$;

-- 金鑰重設碼：只能對同租戶的現役節點
create or replace function public.irori_relay_reissue(p_node text, p_code_hash text, p_id text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_exp timestamptz;
  v_tenant uuid;
begin
  select tenant_id into v_tenant from relay.nodes where id = p_node and role = 'owner' and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not exists (select 1 from relay.nodes where id = p_id and status = 'active' and tenant_id is not distinct from v_tenant) then
    return jsonb_build_object('error', 'not_found');
  end if;
  insert into relay.invites (code_hash, reissue_for, created_by, tenant_id)
    values (p_code_hash, p_id, p_node, v_tenant)
    returning expires_at into v_exp;
  return jsonb_build_object('expires_at', v_exp);
end;
$$;

-- 兌換重設碼：碼的租戶必須與節點的租戶相同
create or replace function public.irori_relay_redeem_reissue(
  p_ip_hash text, p_code_hash text, p_id text, p_key_hash text, p_bell_topic text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_inv relay.invites%rowtype;
  v_n int;
begin
  delete from relay.register_attempts where at < now() - interval '1 day';
  select count(*) into v_n from relay.register_attempts
    where ip_hash = p_ip_hash and at > now() - interval '1 hour';
  if v_n >= 10 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.register_attempts (ip_hash) values (p_ip_hash);

  select * into v_inv from relay.invites where code_hash = p_code_hash for update;
  if not found or v_inv.used_at is not null or v_inv.expires_at < now()
     or v_inv.reissue_for is null or v_inv.reissue_for <> p_id then
    return jsonb_build_object('error', 'invalid_invite');
  end if;
  update relay.nodes set key_hash = p_key_hash, bell_topic = p_bell_topic, last_seen_at = now()
    where id = p_id and status = 'active' and tenant_id is not distinct from v_inv.tenant_id;
  if not found then
    return jsonb_build_object('error', 'invalid_invite');
  end if;
  update relay.invites set used_at = now() where code_hash = p_code_hash;
  return jsonb_build_object('id', p_id, 'bell_topic', p_bell_topic);
end;
$$;

-- 註冊：新節點的租戶取自邀請碼。已離開（left）的舊代號只有同租戶能重用，否則回 id_taken（不能接手別人留下的代號與信件）
create or replace function public.irori_relay_register(
  p_ip_hash text, p_code_hash text, p_id text, p_name text, p_kind text,
  p_machine text, p_note text, p_key_hash text, p_bell_topic text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_inv relay.invites%rowtype;
  v_n int;
  v_old uuid;
  v_has_old boolean;
begin
  delete from relay.register_attempts where at < now() - interval '1 day';
  select count(*) into v_n from relay.register_attempts
    where ip_hash = p_ip_hash and at > now() - interval '1 hour';
  if v_n >= 10 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.register_attempts (ip_hash) values (p_ip_hash);

  select * into v_inv from relay.invites where code_hash = p_code_hash for update;
  if not found or v_inv.used_at is not null or v_inv.expires_at < now() or v_inv.reissue_for is not null
     or (v_inv.for_id is not null and v_inv.for_id <> p_id) then
    return jsonb_build_object('error', 'invalid_invite');
  end if;
  if p_id !~ '^[A-Za-z0-9_-]{1,32}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if v_inv.prefix is not null and left(p_id, char_length(v_inv.prefix)) <> v_inv.prefix then
    return jsonb_build_object('error', 'bad_id_prefix', 'prefix', v_inv.prefix);
  end if;
  if p_name is null or char_length(p_name) not between 1 and 100
     or p_machine is null or char_length(p_machine) not between 1 and 40 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select tenant_id, true into v_old, v_has_old from relay.nodes where id = p_id;
  if coalesce(v_has_old, false) and (
       exists (select 1 from relay.nodes where id = p_id and status = 'active')
       or v_old is distinct from v_inv.tenant_id
     ) then
    return jsonb_build_object('error', 'id_taken');
  end if;
  if p_kind is null or p_kind not in ('claude', 'gpt', 'gemini', 'grok', 'other') then
    p_kind := 'other';
  end if;

  insert into relay.nodes (id, name, key_hash, bell_topic, kind, role, can_invite, machine, note, status, last_seen_at, tenant_id)
    values (p_id, p_name, p_key_hash, p_bell_topic, p_kind, 'member', false, p_machine, left(p_note, 500), 'active', now(), v_inv.tenant_id)
    on conflict (id) do update set
      name = excluded.name, key_hash = excluded.key_hash, bell_topic = excluded.bell_topic,
      kind = excluded.kind, role = 'member', can_invite = false, machine = excluded.machine, note = excluded.note,
      status = 'active', last_seen_at = now();
  update relay.invites set used_at = now() where code_hash = p_code_hash;
  return jsonb_build_object('id', p_id, 'bell_topic', p_bell_topic);
end;
$$;

-- 角色節點改同租戶任一節點的機器／顯示名
create or replace function public.irori_relay_update(p_node text, p_id text, p_machine text, p_name text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
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
$$;

-- ── 7. 群組（rooms）：全部綁租戶 ──

create or replace function relay.room_in_tenant(p_room text, p_node text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from relay.rooms r where r.id = p_room and r.tenant_id is not distinct from relay.node_tenant(p_node));
$$;

-- 成員 key 是否有效且屬於這個租戶：'~owner'、同租戶現役節點、或「同租戶現役節點~roster 上的視窗名」
create or replace function relay.room_key_ok(p_key text, p_tenant uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case
    when p_key is null or char_length(p_key) not between 1 and 120 then false
    when p_key = '~owner' then true
    when position('~' in p_key) = 0 then exists (
      select 1 from relay.nodes where id = p_key and status = 'active' and tenant_id is not distinct from p_tenant)
    else exists (
        select 1 from relay.nodes where id = split_part(p_key, '~', 1) and status = 'active' and tenant_id is not distinct from p_tenant)
      and exists (select 1 from relay.roster where node = split_part(p_key, '~', 1)
                  and name = substr(p_key, position('~' in p_key) + 1))
  end;
$$;

-- 成員顯示名：'~owner' 用租戶主人的稱呼（不再寫死「小良哥」）
create or replace function relay.room_member_name(p_key text, p_tenant uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when p_key = '~owner' then coalesce((select owner_name from relay.tenants where id = p_tenant), '主人')
    when position('~' in p_key) > 0 then substr(p_key, position('~' in p_key) + 1)
    else coalesce((select name from relay.nodes where id = p_key and tenant_id is not distinct from p_tenant), p_key)
  end;
$$;

create or replace function relay.room_members_json(p_room text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', m.member,
    'name', relay.room_member_name(m.member, r.tenant_id),
    'role', m.role,
    'kind', case when m.member = '~owner' then 'owner'
                 when position('~' in m.member) > 0 then 'window'
                 else coalesce(n.kind, 'other') end,
    'node_role', case when m.member = '~owner' then 'owner' else coalesce(n.role, 'member') end,
    'joined_via', m.joined_via
  ) order by m.joined_at, m.member), '[]'::jsonb)
  from relay.room_members m
  join relay.rooms r on r.id = m.room_id
  left join relay.nodes n on n.id = split_part(m.member, '~', 1) and m.member <> '~owner' and n.tenant_id is not distinct from r.tenant_id
  where m.room_id = p_room and m.left_at is null;
$$;

create or replace function public.irori_relay_room_create(p_actor text, p_id text, p_name text, p_members text[])
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  k text;
  v_name text := btrim(coalesce(p_name, ''));
  v_t uuid;
begin
  if not relay.room_actor_is_owner(p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  v_t := relay.node_tenant(p_actor);
  if p_id is null or p_id !~ '^[A-Za-z0-9_-]{1,32}$' or char_length(v_name) not between 1 and 60
     or coalesce(array_length(p_members, 1), 0) > 50 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if exists (select 1 from relay.rooms where id = p_id) then
    return jsonb_build_object('error', 'id_taken');
  end if;
  foreach k in array coalesce(p_members, array[]::text[]) loop
    if k <> '~owner' and not relay.room_key_ok(k, v_t) then
      return jsonb_build_object('error', 'bad_member', 'member', k);
    end if;
  end loop;
  insert into relay.rooms (id, name, created_by, tenant_id) values (p_id, v_name, p_actor, v_t);
  insert into relay.room_members (room_id, member, role) values (p_id, '~owner', 'owner');
  insert into relay.room_members (room_id, member, role)
    select distinct p_id, m, 'member' from unnest(coalesce(p_members, array[]::text[])) m where m <> '~owner';
  insert into relay.room_pins (room_id) values (p_id);
  return jsonb_build_object('id', p_id);
exception when unique_violation then
  return jsonb_build_object('error', 'id_taken');
end;
$$;

create or replace function public.irori_relay_room_add(p_actor text, p_room text, p_member text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_last bigint;
begin
  if not relay.room_actor_is_owner(p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select last_seq into v_last from relay.rooms
    where id = p_room and archived_at is null and tenant_id is not distinct from relay.node_tenant(p_actor);
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_member = '~owner' then
    return jsonb_build_object('ok', true);
  end if;
  if not relay.room_key_ok(p_member, relay.node_tenant(p_actor)) then
    return jsonb_build_object('error', 'bad_member');
  end if;
  insert into relay.room_members (room_id, member, role, read_seq) values (p_room, p_member, 'member', v_last)
    on conflict (room_id, member) do update set left_at = null, joined_at = now(), read_seq = v_last, joined_via = 'manual'
    where relay.room_members.left_at is not null;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.irori_relay_room_remove(p_actor text, p_room text, p_member text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if not relay.room_actor_is_owner(p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_member = '~owner' then
    return jsonb_build_object('error', 'cannot_remove_owner');
  end if;
  update relay.room_members set left_at = now(), joined_via = 'manual'
    where room_id = p_room and member = p_member and left_at is null and relay.room_in_tenant(p_room, p_actor);
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.irori_relay_room_pin_set(p_actor text, p_room text, p_body text, p_version integer)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_new integer;
  v_cur integer;
begin
  if not relay.room_actor_is_owner(p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_body is null or char_length(p_body) > 20000 or p_version is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not relay.room_in_tenant(p_room, p_actor) then
    return jsonb_build_object('error', 'not_found');
  end if;
  update relay.room_pins set body = p_body, version = version + 1, updated_by = '~owner', updated_at = now()
    where room_id = p_room and version = p_version
    returning version into v_new;
  if v_new is null then
    select version into v_cur from relay.room_pins where room_id = p_room;
    if not found then
      return jsonb_build_object('error', 'not_found');
    end if;
    return jsonb_build_object('error', 'version_conflict', 'version', v_cur);
  end if;
  return jsonb_build_object('version', v_new);
end;
$$;

create or replace function public.irori_relay_room_list(p_node text, p_owner boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_out jsonb;
  v_t uuid := relay.node_tenant(p_node);
begin
  if p_owner and not relay.room_actor_is_owner(p_node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'name', r.name, 'created_at', r.created_at, 'last_seq', r.last_seq, 'auto_prefixes', to_jsonb(r.auto_prefixes),
    'last_at', lm.at, 'last_from', lm.from_member,
    'last_from_name', case when lm.from_member is null then null else relay.room_member_name(lm.from_member, v_t) end,
    'last_body', left(lm.body, 120),
    'mine', (select coalesce(jsonb_agg(jsonb_build_object(
        'member', rm.member, 'read_seq', rm.read_seq,
        'unread', (select count(*) from relay.room_messages m
                   where m.room_id = r.id and m.seq > rm.read_seq and m.from_member <> rm.member)
      ) order by rm.member), '[]'::jsonb)
      from relay.room_members rm
      where rm.room_id = r.id and rm.left_at is null
        and case when p_owner then rm.member = '~owner'
                 else (rm.member = p_node or left(rm.member, char_length(p_node) + 1) = p_node || '~') end),
    'members', relay.room_members_json(r.id)
  ) order by coalesce(lm.at, r.created_at) desc), '[]'::jsonb)
  into v_out
  from relay.rooms r
  left join lateral (
    select m.at, m.from_member, m.body from relay.room_messages m where m.room_id = r.id order by m.seq desc limit 1
  ) lm on true
  where r.archived_at is null
    and r.tenant_id is not distinct from v_t
    and exists (
      select 1 from relay.room_members rm
      where rm.room_id = r.id and rm.left_at is null
        and case when p_owner then rm.member = '~owner'
                 else (rm.member = p_node or left(rm.member, char_length(p_node) + 1) = p_node || '~') end
    );
  return jsonb_build_object('rooms', v_out);
end;
$$;

create or replace function public.irori_relay_room_members(p_node text, p_agent text, p_room text, p_owner boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_key text := relay.room_caller_key(p_node, p_agent, p_owner);
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not relay.room_in_tenant(p_room, p_node) or not relay.room_is_member(p_room, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  return jsonb_build_object('key', v_key,
    'room', (select jsonb_build_object('id', r.id, 'name', r.name, 'auto_prefixes', to_jsonb(r.auto_prefixes)) from relay.rooms r where r.id = p_room),
    'members', relay.room_members_json(p_room));
end;
$$;

create or replace function public.irori_relay_room_pin_get(p_node text, p_agent text, p_room text, p_owner boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_key text := relay.room_caller_key(p_node, p_agent, p_owner);
  v_pin relay.room_pins%rowtype;
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not relay.room_in_tenant(p_room, p_node) or not relay.room_is_member(p_room, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  select * into v_pin from relay.room_pins where room_id = p_room;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('body', v_pin.body, 'version', v_pin.version, 'updated_at', v_pin.updated_at);
end;
$$;

create or replace function public.irori_relay_room_post(
  p_node text, p_agent text, p_room text, p_body text, p_mentions text[], p_owner boolean default false
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
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
  v_trust := case when p_owner or relay.room_actor_is_owner(p_node) then 'owner' else 'member' end;
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
$$;

create or replace function public.irori_relay_room_read(
  p_node text, p_agent text, p_room text, p_since bigint, p_limit integer, p_owner boolean default false,
  p_tail boolean default false, p_mark boolean default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_key text := relay.room_caller_key(p_node, p_agent, p_owner);
  v_read bigint;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_since bigint;
  v_msgs jsonb;
  v_max bigint;
  v_last bigint;
  v_t uuid := relay.node_tenant(p_node);
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not relay.room_in_tenant(p_room, p_node) or not relay.room_is_member(p_room, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  select read_seq into v_read from relay.room_members where room_id = p_room and member = v_key;
  select last_seq into v_last from relay.rooms where id = p_room;
  v_since := coalesce(p_since, case when p_tail then null else v_read end);
  select coalesce(jsonb_agg(jsonb_build_object(
      'seq', s.seq, 'from', s.from_member, 'from_name', relay.room_member_name(s.from_member, v_t),
      'trust', s.trust, 'body', s.body, 'mentions', to_jsonb(s.mentions), 'at', s.at
    ) order by s.seq), '[]'::jsonb), max(s.seq)
  into v_msgs, v_max
  from (
    select * from (
      select m.* from relay.room_messages m
      where m.room_id = p_room and (v_since is null or m.seq > v_since)
      order by case when v_since is null then -m.seq else m.seq end
      limit v_limit
    ) t
  ) s;
  if v_max is not null and coalesce(p_mark, p_since is null and not coalesce(p_tail, false)) then
    update relay.room_members set read_seq = greatest(read_seq, v_max) where room_id = p_room and member = v_key;
  end if;
  return jsonb_build_object('messages', v_msgs, 'last_seq', v_last, 'key', v_key);
end;
$$;

create or replace function public.irori_relay_room_set_prefixes(p_actor text, p_room text, p_prefixes text[])
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare k text;
begin
  if not relay.room_actor_is_owner(p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_prefixes is null or coalesce(array_length(p_prefixes, 1), 0) > 10 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  foreach k in array p_prefixes loop
    if k is null or char_length(k) not between 1 and 40 or btrim(k) = '' or position('~' in k) > 0 then
      return jsonb_build_object('error', 'bad_request');
    end if;
  end loop;
  update relay.rooms set auto_prefixes = (select coalesce(array_agg(distinct x), array[]::text[]) from unnest(p_prefixes) x)
    where id = p_room and archived_at is null and tenant_id is not distinct from relay.node_tenant(p_actor);
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- 自動收入規則：只給這個節點所屬租戶的群組
create or replace function public.irori_relay_room_auto_rules(p_node text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('room', id, 'prefixes', to_jsonb(auto_prefixes))), '[]'::jsonb)
  from relay.rooms
  where archived_at is null and coalesce(array_length(auto_prefixes, 1), 0) > 0
    and tenant_id is not distinct from relay.node_tenant(p_node);
$$;

-- 舊的無參數版：只回租戶 1 的群組（過渡期；新版不再呼叫）
create or replace function public.irori_relay_room_auto_rules()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('room', id, 'prefixes', to_jsonb(auto_prefixes))), '[]'::jsonb)
  from relay.rooms
  where archived_at is null and coalesce(array_length(auto_prefixes, 1), 0) > 0
    and tenant_id is not distinct from '00000000-0000-0000-0000-000000000001'::uuid;
$$;

create or replace function public.irori_relay_room_auto_apply(p_node text, p_joins jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  j jsonb;
  v_last bigint;
  v_key text;
  v_added int := 0;
  v_left int := 0;
  v_keys text[] := array[]::text[];
  v_t uuid;
begin
  select tenant_id into v_t from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_joins is null or jsonb_typeof(p_joins) <> 'array' or jsonb_array_length(p_joins) > 500 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  for j in select * from jsonb_array_elements(p_joins) loop
    if jsonb_typeof(j->'room') is distinct from 'string' or jsonb_typeof(j->'name') is distinct from 'string' then
      continue;
    end if;
    if not exists (select 1 from relay.roster where node = p_node and name = j->>'name') then
      continue;
    end if;
    select last_seq into v_last from relay.rooms
      where id = j->>'room' and archived_at is null and tenant_id is not distinct from v_t and exists (
        select 1 from unnest(auto_prefixes) pf where left(j->>'name', char_length(pf)) = pf);
    if not found then
      continue;
    end if;
    v_key := p_node || '~' || (j->>'name');
    v_keys := array_append(v_keys, (j->>'room') || '|' || v_key);
    insert into relay.room_members (room_id, member, role, read_seq, joined_via)
      values (j->>'room', v_key, 'member', v_last, 'auto')
      on conflict (room_id, member) do update set left_at = null, joined_at = now(), read_seq = v_last
      where relay.room_members.left_at is not null and relay.room_members.joined_via = 'auto';
    if found then v_added := v_added + 1; end if;
  end loop;
  update relay.room_members m set left_at = now()
    where m.joined_via = 'auto' and m.left_at is null
      and left(m.member, char_length(p_node) + 1) = p_node || '~'
      and not ((m.room_id || '|' || m.member) = any (v_keys));
  get diagnostics v_left = row_count;
  return jsonb_build_object('added', v_added, 'left', v_left);
end;
$$;

-- ── 8. 遠端開視窗：同租戶 ──

create or replace function public.irori_relay_launch(
  p_actor text, p_node text, p_profile text, p_name text, p_cwd text, p_first text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_l jsonb;
  v_topic text;
  v_max int;
  v_id uuid;
  v_t uuid;
begin
  select tenant_id into v_t from relay.nodes where id = p_actor and role = 'owner' and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select launcher, bell_topic into v_l, v_topic from relay.nodes
    where id = p_node and status = 'active' and tenant_id is not distinct from v_t;
  if v_topic is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_l is null then
    return jsonb_build_object('error', 'no_launcher');
  end if;
  if not public.irori_relay_launch_name_ok(p_name) then
    return jsonb_build_object('error', 'bad_name');
  end if;
  if p_profile is null or not exists (select 1 from jsonb_array_elements(v_l->'profiles') p where p->>'id' = p_profile) then
    return jsonb_build_object('error', 'bad_profile');
  end if;
  if p_cwd is null or not exists (select 1 from jsonb_array_elements_text(v_l->'cwd_allow') c where c = p_cwd) then
    return jsonb_build_object('error', 'bad_cwd');
  end if;
  if p_first is not null and char_length(p_first) > 4000 then
    return jsonb_build_object('error', 'bad_first_message');
  end if;
  if exists (select 1 from relay.roster where node = p_node and lower(name) = lower(p_name) and seen_at > now() - interval '3 minutes')
     or exists (select 1 from relay.launches where node = p_node and lower(name) = lower(p_name)
                and (status in ('pending', 'taken') and created_at > now() - interval '10 minutes'
                     or status in ('ok', 'unconfirmed') and done_at > now() - interval '3 minutes')) then
    return jsonb_build_object('error', 'name_taken');
  end if;
  v_max := coalesce((v_l->>'max_per_hour')::int, 6);
  if (select count(*) from relay.launches where node = p_node and created_at > now() - interval '1 hour') >= v_max then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.launches (requested_by, node, profile, name, cwd, first_message, tenant_id)
    values (p_actor, p_node, p_profile, p_name, p_cwd, nullif(p_first, ''), v_t)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$$;

create or replace function public.irori_relay_launchers(p_actor text, p_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_mach jsonb; v_recent jsonb; v_t uuid;
begin
  select tenant_id into v_t from relay.nodes where id = p_actor and role = 'owner' and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'node', n.id, 'name', n.name, 'machine', n.machine, 'launcher', n.launcher, 'launcher_at', n.launcher_at,
      'online', coalesce(n.last_seen_at > now() - interval '3 minutes', false)) order by n.id), '[]'::jsonb)
    into v_mach from relay.nodes n
    where n.status = 'active' and n.launcher is not null and n.tenant_id is not distinct from v_t;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'node', l.node, 'profile', l.profile, 'name', l.name, 'cwd', l.cwd,
      'status', case when l.status = 'pending' and l.created_at <= now() - interval '2 minutes' then 'failed' else l.status end,
      'detail', case when l.status = 'pending' and l.created_at <= now() - interval '2 minutes'
                     then '機器橋 2 分鐘內沒有取走（電腦可能沒開或橋沒在跑）' else l.detail end,
      'created_at', l.created_at, 'done_at', l.done_at) order by l.created_at desc), '[]'::jsonb)
    into v_recent from (
      select * from relay.launches
      where tenant_id is not distinct from v_t
        and ((p_ids is null and created_at > now() - interval '7 days') or id = any(p_ids))
      order by created_at desc limit 30
    ) l;
  return jsonb_build_object('machines', v_mach, 'launches', v_recent);
end;
$$;

-- ── 9. 權限：只有 service_role 能執行 ──

do $$
declare f text;
begin
  foreach f in array array[
    'public.irori_tenant_claim_legacy(text)',
    'public.irori_tenant_provision(uuid,text)',
    'public.irori_tenant_of_user(uuid)',
    'public.irori_relay_whoami(uuid)',
    'public.irori_tenant_set_owner_name(uuid,text)',
    'public.irori_account_resolve(uuid,text,text,boolean,numeric)',
    'public.irori_account_invite_create(uuid,text,text,text,text,integer)',
    'public.irori_account_invite_revoke(uuid)',
    'public.irori_account_redeem(uuid,text,text,text,numeric)',
    'public.irori_account_set_status(text,text)',
    'public.irori_account_list()',
    'public.irori_relay_auth(text)',
    'public.irori_relay_send(text,text,text,text,text,uuid)',
    'public.irori_relay_list(uuid)',
    'public.irori_relay_list_by_node(text)',
    'public.irori_relay_list()',
    'public.irori_relay_invite(text,text,text)',
    'public.irori_relay_reissue(text,text,text)',
    'public.irori_relay_redeem_reissue(text,text,text,text,text)',
    'public.irori_relay_register(text,text,text,text,text,text,text,text,text)',
    'public.irori_relay_update(text,text,text,text)',
    'public.irori_relay_room_create(text,text,text,text[])',
    'public.irori_relay_room_add(text,text,text)',
    'public.irori_relay_room_remove(text,text,text)',
    'public.irori_relay_room_pin_set(text,text,text,integer)',
    'public.irori_relay_room_list(text,boolean)',
    'public.irori_relay_room_members(text,text,text,boolean)',
    'public.irori_relay_room_pin_get(text,text,text,boolean)',
    'public.irori_relay_room_post(text,text,text,text,text[],boolean)',
    'public.irori_relay_room_read(text,text,text,bigint,integer,boolean,boolean,boolean)',
    'public.irori_relay_room_set_prefixes(text,text,text[])',
    'public.irori_relay_room_auto_rules(text)',
    'public.irori_relay_room_auto_rules()',
    'public.irori_relay_room_auto_apply(text,jsonb)',
    'public.irori_relay_launch(text,text,text,text,text,text)',
    'public.irori_relay_launchers(text,uuid[])'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
