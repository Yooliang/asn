-- 手機「重新登入 Claude」與「安裝並登入」分開判斷（#1592）。
-- 起因：重新登入原本共用「安裝並登入」的請求，電腦端被預設關著的安裝開關擋下。這裡只讓請求多帶一個模式，
--   本機怎麼判斷由電腦端決定：重新登入不受安裝開關限制，改用本人身分確認；要安裝或更新仍照舊看開關。
-- 做三件事（兩個既有函式只多加行，其餘逐字不變，測試逐行比對）：
--   1. relay.setup_requests 加 mode 欄（預設 'install'，check 只收 'install'、'relogin'）；既有的列都是 install
--   2. public.asn_setup_request 多收 p_mode（預設 'install'，舊版手機與舊 Edge 不帶＝舊行為）；不是這兩個值、或 relogin 搭配非 claude 回 bad_request；
--      已有進行中請求時回應多帶那筆的 mode
--   3. public.asn_relay_setup_poll 交請求時多帶 mode（舊版 ASN 不讀這個欄，行為不變）
-- security definer 函式碰到的資料表（全部 set search_path to ''、只授權 service_role，與上一版相同）：
--   asn_setup_request：讀 relay.nodes、relay.asn_presence、relay.device_keys、relay.account_events；寫 relay.setup_requests、relay.account_events
--   asn_relay_setup_poll：讀寫 relay.setup_requests，讀 relay.nodes、relay.device_keys
-- 部署順序：本 migration → Edge（account）→ 發新版 ASN。提早上任何一步都不會壞（舊 Edge 不帶 p_mode，用預設值）。
-- 回復：supabase/sql/rollback/20261116100000_setup_mode_down.sql（刪掉 relogin 的請求、drop 七參數函式與 mode 欄、兩個函式換回上一版原文）。
begin;

alter table relay.setup_requests add column if not exists mode text not null default 'install';
alter table relay.setup_requests drop constraint if exists setup_requests_mode_check;
alter table relay.setup_requests add constraint setup_requests_mode_check check (mode in ('install', 'relogin'));

-- 舊的六參數版本要先 drop，免得具名呼叫有歧義
drop function if exists public.asn_setup_request(uuid, text, text, text, text, text);
create or replace function public.asn_setup_request(p_user uuid, p_node text, p_kind text default 'claude', p_payload text default null, p_sig text default null, p_p_node text default null, p_mode text default 'install')
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
  -- 模式只有 install（安裝並登入，舊行為）與 relogin（只重新登入，不安裝）；重新登入只對 claude。舊版手機不帶＝install
  if p_mode is null or p_mode not in ('install', 'relogin') or (p_mode = 'relogin' and p_kind <> 'claude') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 不是自己的節點、或節點不存在：一律回 not_found
  if p_user is null or not exists (select 1 from relay.nodes where id = p_node and status = 'active' and owner_user = p_user) then
    return jsonb_build_object('error', 'not_found');
  end if;
  -- 手機（安卓／iOS）不能被安裝：沒有電腦那一套（asn真 清單第 2 點）。平台是空的（舊版或機器橋沒回報）照舊當電腦
  if exists (select 1 from relay.nodes where id = p_node and platform in ('android', 'ios')) then
    return jsonb_build_object('error', 'unsupported_platform');
  end if;
  -- 裝置碼型：要有請求本文、手機的設備簽章、發起的手機（本人的、有設備公鑰）。後台只檢查格式與欄位一致
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
    if jsonb_typeof(v_j) is distinct from 'object'
       or v_j ->> 'v' is distinct from 'asn-device-login-req-v1'
       or v_j ->> 't_node' is distinct from p_node
       or v_j ->> 'p_node' is distinct from p_p_node
       or v_j ->> 'vendor' is distinct from p_kind
       or coalesce(v_rid, '') !~ '^[A-Za-z0-9_-]{22}$'
       or coalesce(v_j ->> 'p_eph_pub', '') !~ '^[A-Za-z0-9_-]{43}$'
       or jsonb_typeof(v_j -> 'exp') is distinct from 'number' then
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
    return jsonb_build_object('ok', true, 'already', true, 'state', v_r.status, 'kind', v_r.kind, 'mode', v_r.mode);
  end if;
  if found and v_r.status = 'failed' and v_r.updated_at > now() - interval '1 minute' then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  if (select count(*) from relay.account_events where user_id = p_user and event = 'setup_requested' and at > now() - interval '1 hour') >= 6 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  -- rid 只在列存活期間不重複：只查現存的列，同一台的請求被新請求覆蓋、或列被刪除後，舊的 rid 就不再檢查
  if v_device and exists (select 1 from relay.setup_requests where rid = v_rid) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  insert into relay.setup_requests (node, requested_by, kind, status, detail, replaced, requested_at, updated_at,
                                    rid, req_payload, req_sig, req_p_node, t_eph_pub, cipher, t_sig, cipher_put_at, delivered_at, expires_at, mode)
    values (p_node, p_user, p_kind, 'pending', null, null, now(), now(),
            case when v_device then v_rid end, case when v_device then p_payload end, case when v_device then p_sig end,
            case when v_device then p_p_node end, null, null, null, null, null,
            case when v_device then to_timestamp(v_exp) end, p_mode)
  on conflict (node) do update
    set requested_by = excluded.requested_by, kind = excluded.kind, status = 'pending', detail = null, replaced = null,
        requested_at = excluded.requested_at, updated_at = excluded.updated_at,
        rid = excluded.rid, req_payload = excluded.req_payload, req_sig = excluded.req_sig, req_p_node = excluded.req_p_node,
        t_eph_pub = null, cipher = null, t_sig = null, cipher_put_at = null, delivered_at = null, expires_at = excluded.expires_at,
        mode = excluded.mode;
  insert into relay.account_events (user_id, event, node) values (p_user, 'setup_requested', p_node);
  return jsonb_build_object('ok', true, 'already', false, 'state', 'pending');
end;
$function$;
revoke all on function public.asn_setup_request(uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_setup_request(uuid, text, text, text, text, text, text) to service_role;

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
    return jsonb_build_object('requested', true, 'requested_by', v_r.requested_by, 'kind', v_r.kind, 'mode', v_r.mode);
  end if;
  select sign_pub into v_pub from relay.device_keys where node = v_r.req_p_node;
  return jsonb_build_object('requested', true, 'requested_by', v_r.requested_by, 'kind', v_r.kind, 'mode', v_r.mode,
    'rid', v_r.rid, 'payload', v_r.req_payload, 'sig', v_r.req_sig, 'p_node', v_r.req_p_node, 'p_sign_pub', v_pub,
    'expires_at', floor(extract(epoch from v_r.expires_at)));
end;
$function$;

commit;
