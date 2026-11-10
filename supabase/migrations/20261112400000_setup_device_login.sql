-- 手機替電腦安裝並登入「別家 CLI」（#933 PR-6＋PR-5b 後台；計畫 docs/design/CLI-INSTALL-933.md，安全細節在私有設計）。
-- 做四件事：
--   1. 官方登入網址白名單（secret_requests.link 的約束與 asn_relay_secret_request_link）多收 auth.openai.com、accounts.x.ai（只收這兩個主機本身）。
--      唯一來源是 supabase/functions/_shared/login_domains.json，這裡的規則由一致性測試比對。
--   2. relay.setup_requests：kind 擴成 claude／codex／agy／grok；多存「裝置碼型」登入用的欄位（請求本文與手機的設備簽章、
--      電腦回傳的密文與電腦的設備簽章、到期時間）。後台**只存、只轉交**，不驗任何簽章、看不到明文（驗章在兩端本機）。
--   3. public.asn_setup_request 多收 kind 與裝置碼型的請求本文、簽章、發起手機的節點；public.asn_relay_setup_poll 交請求時多帶這些
--      和發起手機的設備公鑰（只轉交，信任看電腦本機記的）。舊的兩參數呼叫照舊是 claude。
--   4. 新函式：asn_relay_setup_code_put（電腦，節點金鑰，寫一次就鎖）、asn_setup_code_fetch（本人，登入憑證，取一次就清）。
-- 非 claude 的種類要電腦的 ASN 夠新才交：最低版本先設成 9999.0.0（等於還不交），PR-5b 電腦端發版後另開小 migration 改成那一版。
-- security definer 函式碰到的資料表：
--   asn_setup_request：讀 relay.nodes、relay.asn_presence、relay.device_keys（發起手機要有設備公鑰）、relay.account_events；寫 relay.setup_requests、relay.account_events
--   asn_relay_setup_poll：讀寫 relay.setup_requests，讀 relay.nodes、relay.device_keys
--   asn_relay_setup_code_put：寫 relay.setup_requests（只動自己節點那一列）
--   asn_setup_code_fetch：讀寫 relay.setup_requests（只回本人送出的那一列），讀 relay.device_keys
--   asn_relay_secret_request_link：與原本相同，只換網址規則
-- 全部 set search_path to ''，只授權 service_role。
-- 部署順序：本 migration → Edge（relay、account）→ 發新版 ASN。舊版 Edge 呼叫兩參數的 asn_setup_request（具名參數），解析到新函式的預設值，行為不變。
-- 回復：supabase/sql/rollback/20261112400000_setup_device_login_down.sql。
begin;

-- 1. 官方登入網址白名單（和 _shared/login_domains.json 一致）
alter table relay.secret_requests drop constraint if exists secret_requests_link_ck;
alter table relay.secret_requests add constraint secret_requests_link_ck check (
  link is null or (
    char_length(link) between 12 and 2048
    and link ~ '^https://(([a-z0-9-]+\.)*(claude\.ai|claude\.com|anthropic\.com)|auth\.openai\.com|accounts\.x\.ai)(:443)?([/?#][\x21-\x5b\x5d-\x7e]*)?$'
  )
);

create or replace function public.asn_relay_secret_request_link(p_node text, p_pub text, p_program text, p_purpose text, p_ttl_seconds integer, p_link text, p_signed_user uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_res jsonb;
begin
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_link is null
     or char_length(p_link) not between 12 and 2048
     or p_link !~ '^https://(([a-z0-9-]+\.)*(claude\.ai|claude\.com|anthropic\.com)|auth\.openai\.com|accounts\.x\.ai)(:443)?([/?#][\x21-\x5b\x5d-\x7e]*)?$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  v_res := public.asn_relay_secret_request(p_node, p_pub, p_program, p_purpose, p_ttl_seconds);
  if v_res ? 'error' then
    return v_res;
  end if;
  update relay.secret_requests set link = p_link where id = (v_res ->> 'id')::uuid and requester_node = p_node;
  return v_res;
end;
$function$;

-- 2. setup_requests 的種類與裝置碼型欄位
alter table relay.setup_requests drop constraint if exists setup_requests_kind_check;
alter table relay.setup_requests add constraint setup_requests_kind_check check (kind in ('claude', 'codex', 'agy', 'grok'));
alter table relay.setup_requests
  add column if not exists rid text,
  add column if not exists req_payload text,
  add column if not exists req_sig text,
  add column if not exists req_p_node text,
  add column if not exists t_eph_pub text,
  add column if not exists cipher text,
  add column if not exists t_sig text,
  add column if not exists cipher_put_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists expires_at timestamptz;
alter table relay.setup_requests drop constraint if exists setup_requests_rid_key;
alter table relay.setup_requests add constraint setup_requests_rid_key unique (rid);
alter table relay.setup_requests drop constraint if exists setup_requests_device_ck;
alter table relay.setup_requests add constraint setup_requests_device_ck check (
  (rid is null or rid ~ '^[A-Za-z0-9_-]{22}$')
  and (req_payload is null or char_length(req_payload) <= 1024)
  and (req_sig is null or req_sig ~ '^[A-Za-z0-9_-]{86}$')
  and (req_p_node is null or req_p_node ~ '^[A-Za-z0-9_-]{1,32}$')
  and (t_eph_pub is null or t_eph_pub ~ '^[A-Za-z0-9_-]{43}$')
  and (cipher is null or (char_length(cipher) between 16 and 4096 and cipher ~ '^[A-Za-z0-9_-]+$'))
  and (t_sig is null or t_sig ~ '^[A-Za-z0-9_-]{86}$')
  -- 裝置碼型（codex、grok）一定有請求本文、簽章、發起手機與到期時間；其他種類一律沒有
  and (case when kind in ('codex', 'grok')
            then rid is not null and req_payload is not null and req_sig is not null and req_p_node is not null and expires_at is not null
            else rid is null and req_payload is null and req_sig is null and req_p_node is null and cipher is null and t_sig is null end)
);

-- 各種類要電腦的 ASN 至少哪一版才交請求。claude 照舊（0.2.2）；其他先設成 9999.0.0（還不交），電腦端發版後另開 migration 改
create or replace function relay.setup_kind_version_ok(p_version text, p_kind text)
 returns boolean language sql immutable set search_path to ''
as $function$
  select relay.setup_version_ok(p_version)
     and string_to_array(substring(p_version from '^[0-9]+\.[0-9]+\.[0-9]+'), '.')::int[]
         >= case p_kind when 'claude' then array[0, 2, 2] else array[9999, 0, 0] end;
$function$;
revoke all on function relay.setup_kind_version_ok(text, text) from public, anon, authenticated;

-- 3. 送出請求：多收種類與裝置碼型的請求本文（兩參數的舊呼叫＝claude，行為不變）
drop function if exists public.asn_setup_request(uuid, text);
create or replace function public.asn_setup_request(p_user uuid, p_node text, p_kind text default 'claude', p_payload text default null, p_sig text default null, p_p_node text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_r relay.setup_requests%rowtype;
  v_j jsonb;
  v_rid text;
  v_exp numeric;
  v_device boolean := p_kind in ('codex', 'grok');
begin
  if p_kind is null or p_kind not in ('claude', 'codex', 'agy', 'grok') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 不是自己的節點、或節點不存在：一律 not_found（不透露別人帳號下有沒有這台）
  if p_user is null or not exists (select 1 from relay.nodes where id = p_node and status = 'active' and owner_user = p_user) then
    return jsonb_build_object('error', 'not_found');
  end if;
  -- 手機（安卓／iOS）不能被安裝：沒有電腦那一套（asn真 清單第 2 點）。平台是空的（舊版或機器橋沒回報）照舊當電腦
  if exists (select 1 from relay.nodes where id = p_node and platform in ('android', 'ios')) then
    return jsonb_build_object('error', 'unsupported_platform');
  end if;
  -- 裝置碼型：要有請求本文、手機的設備簽章、發起的手機（本人的、有設備公鑰）。後台只檢查格式與欄位一致，不驗簽（驗章在電腦本機）
  if v_device then
    if p_payload is null or p_sig is null or p_p_node is null
       or char_length(p_payload) > 1024 or p_sig !~ '^[A-Za-z0-9_-]{86}$' or p_p_node !~ '^[A-Za-z0-9_-]{1,32}$' then
      return jsonb_build_object('error', 'bad_request');
    end if;
    if not exists (select 1 from relay.nodes where id = p_p_node and status = 'active' and owner_user = p_user)
       or not exists (select 1 from relay.device_keys where node = p_p_node) then
      return jsonb_build_object('error', 'bad_request');
    end if;
    begin
      v_j := p_payload::jsonb;
    exception when others then
      return jsonb_build_object('error', 'bad_request');
    end;
    v_rid := v_j ->> 'rid';
    if jsonb_typeof(v_j) <> 'object'
       or v_j ->> 'v' is distinct from 'asn-device-login-req-v1'
       or v_j ->> 't_node' is distinct from p_node
       or v_j ->> 'p_node' is distinct from p_p_node
       or v_j ->> 'vendor' is distinct from p_kind
       or coalesce(v_rid, '') !~ '^[A-Za-z0-9_-]{22}$'
       or coalesce(v_j ->> 'p_eph_pub', '') !~ '^[A-Za-z0-9_-]{43}$'
       or jsonb_typeof(v_j -> 'exp') <> 'number' then
      return jsonb_build_object('error', 'bad_request');
    end if;
    v_exp := (v_j ->> 'exp')::numeric;
    -- 到期時間要在未來、而且不超過現在＋15 分鐘（容許 60 秒時鐘誤差）
    if v_exp <= extract(epoch from now()) or v_exp > extract(epoch from now()) + 960 then
      return jsonb_build_object('error', 'bad_request');
    end if;
  elsif p_payload is not null or p_sig is not null or p_p_node is not null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - interval '3 minutes') then
    return jsonb_build_object('error', 'asn_offline');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - interval '3 minutes' and relay.setup_kind_version_ok(version, p_kind)) then
    return jsonb_build_object('error', 'asn_outdated');
  end if;
  perform pg_advisory_xact_lock(hashtext('setup_request:' || p_user::text));
  select * into v_r from relay.setup_requests where node = p_node for update;
  if found and ((v_r.status = 'pending' and v_r.requested_at > now() - interval '10 minutes')
             or (v_r.status = 'taken' and v_r.updated_at > now() - interval '40 minutes')) then
    -- 這台已經有進行中的請求：照舊回 already（舊版手機的行為不變），多帶那筆的種類。
    -- 裝置碼型每次都用新的 rid，所以手機看到 already 就知道不是自己這次的請求
    return jsonb_build_object('ok', true, 'already', true, 'state', v_r.status, 'kind', v_r.kind);
  end if;
  if found and v_r.status = 'failed' and v_r.updated_at > now() - interval '1 minute' then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  if (select count(*) from relay.account_events where user_id = p_user and event = 'setup_requested' and at > now() - interval '1 hour') >= 6 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  -- 同一個 rid 用過就不能再用（重放）
  if v_device and exists (select 1 from relay.setup_requests where rid = v_rid) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  insert into relay.setup_requests (node, requested_by, kind, status, detail, replaced, requested_at, updated_at,
                                    rid, req_payload, req_sig, req_p_node, t_eph_pub, cipher, t_sig, cipher_put_at, delivered_at, expires_at)
    values (p_node, p_user, p_kind, 'pending', null, null, now(), now(),
            case when v_device then v_rid end, case when v_device then p_payload end, case when v_device then p_sig end,
            case when v_device then p_p_node end, null, null, null, null, null,
            case when v_device then to_timestamp(v_exp) end)
  on conflict (node) do update
    set requested_by = excluded.requested_by, kind = excluded.kind, status = 'pending', detail = null, replaced = null,
        requested_at = excluded.requested_at, updated_at = excluded.updated_at,
        rid = excluded.rid, req_payload = excluded.req_payload, req_sig = excluded.req_sig, req_p_node = excluded.req_p_node,
        t_eph_pub = null, cipher = null, t_sig = null, cipher_put_at = null, delivered_at = null, expires_at = excluded.expires_at;
  insert into relay.account_events (user_id, event, node) values (p_user, 'setup_requested', p_node);
  return jsonb_build_object('ok', true, 'already', false, 'state', 'pending');
end;
$function$;
revoke all on function public.asn_setup_request(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_setup_request(uuid, text, text, text, text, text) to service_role;

-- 電腦取請求：多帶種類與裝置碼型的欄位、發起手機的設備公鑰（只轉交）。版本不夠新就不交那個種類
create or replace function public.asn_relay_setup_poll(p_node text, p_version text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_r relay.setup_requests%rowtype;
  v_pub text;
begin
  -- 過期的 pending 直接清掉；taken 太久沒回報的標成失敗，讓手機看得到；過期的密文清掉
  delete from relay.setup_requests where node = p_node and status = 'pending'
    and (requested_at <= now() - interval '10 minutes' or (expires_at is not null and expires_at <= now()));
  update relay.setup_requests set status = 'failed', detail = '電腦沒有回報結果，已逾時', updated_at = now()
    where node = p_node and status = 'taken' and updated_at <= now() - interval '40 minutes';
  update relay.setup_requests set cipher = null where node = p_node and cipher is not null and expires_at <= now();
  -- 手機不交（沒有電腦那一套會把請求標成 taken 卻不做）；平台是空的照舊當電腦
  if exists (select 1 from relay.nodes where id = p_node and platform in ('android', 'ios')) then
    return jsonb_build_object('requested', false);
  end if;
  select * into v_r from relay.setup_requests where node = p_node for update;
  if not found or v_r.status <> 'pending' then
    return jsonb_build_object('requested', false);
  end if;
  -- 版本不夠新的 ASN 看不懂這個種類，不交給它（請求留著，等夠新的視窗來取，或過期）
  if not relay.setup_kind_version_ok(p_version, v_r.kind) then
    return jsonb_build_object('requested', false);
  end if;
  update relay.setup_requests set status = 'taken', updated_at = now() where node = p_node;
  if v_r.kind not in ('codex', 'grok') then
    return jsonb_build_object('requested', true, 'requested_by', v_r.requested_by, 'kind', v_r.kind);
  end if;
  select sign_pub into v_pub from relay.device_keys where node = v_r.req_p_node;
  return jsonb_build_object('requested', true, 'requested_by', v_r.requested_by, 'kind', v_r.kind,
    'rid', v_r.rid, 'payload', v_r.req_payload, 'sig', v_r.req_sig, 'p_node', v_r.req_p_node, 'p_sign_pub', v_pub,
    'expires_at', floor(extract(epoch from v_r.expires_at)));
end;
$function$;

-- 4a. 電腦放回密文（節點金鑰；只能放自己節點、已取走、還沒放過、沒過期的那一筆；放一次就鎖住）
create or replace function public.asn_relay_setup_code_put(p_node text, p_rid text, p_t_eph_pub text, p_cipher text, p_t_sig text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_n int;
begin
  if p_rid is null or p_rid !~ '^[A-Za-z0-9_-]{22}$'
     or p_t_eph_pub is null or p_t_eph_pub !~ '^[A-Za-z0-9_-]{43}$'
     or p_cipher is null or char_length(p_cipher) not between 16 and 4096 or p_cipher !~ '^[A-Za-z0-9_-]+$'
     or p_t_sig is null or p_t_sig !~ '^[A-Za-z0-9_-]{86}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.setup_requests
     set t_eph_pub = p_t_eph_pub, cipher = p_cipher, t_sig = p_t_sig, cipher_put_at = now(), updated_at = now()
   where node = p_node and rid = p_rid and kind in ('codex', 'grok') and status = 'taken'
     and cipher is null and cipher_put_at is null and delivered_at is null and expires_at > now();
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;
revoke all on function public.asn_relay_setup_code_put(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_setup_code_put(text, text, text, text, text) to service_role;

-- 4b. 手機取回密文（本人；只回自己送出的那一筆；取一次就清）。電腦的設備公鑰只轉交，手機比對自己本機記的
create or replace function public.asn_setup_code_fetch(p_user uuid, p_rid text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_r relay.setup_requests%rowtype;
  v_pub text;
begin
  if p_user is null or p_rid is null or p_rid !~ '^[A-Za-z0-9_-]{22}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select * into v_r from relay.setup_requests where rid = p_rid and requested_by = p_user for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_r.expires_at <= now() then
    update relay.setup_requests set cipher = null where rid = p_rid;
    return jsonb_build_object('state', 'expired');
  end if;
  if v_r.delivered_at is not null then
    return jsonb_build_object('state', 'delivered');
  end if;
  if v_r.cipher is null then
    return jsonb_build_object('state', 'waiting', 'status', v_r.status, 'detail', v_r.detail);
  end if;
  select sign_pub into v_pub from relay.device_keys where node = v_r.node;
  update relay.setup_requests set cipher = null, delivered_at = now() where rid = p_rid;
  return jsonb_build_object('state', 'ready', 't_node', v_r.node, 't_sign_pub', v_pub,
    't_eph_pub', v_r.t_eph_pub, 'cipher', v_r.cipher, 't_sig', v_r.t_sig);
end;
$function$;
revoke all on function public.asn_setup_code_fetch(uuid, text) from public, anon, authenticated;
grant execute on function public.asn_setup_code_fetch(uuid, text) to service_role;

commit;
