-- 回復 20261117100000_secret_target.sql（#1593）：
--   drop 八參數函式與 requester_phone、target_node 兩欄，六個函式換回上一版原文
--   （asn_setup_request、asn_relay_setup_poll 取自 20261116200000_setup_mode.sql；asn_relay_setup_result 取自 20261102140000_setup_requests.sql；
--    asn_relay_secret_request_link 取自 20261112400000_setup_device_login.sql；asn_relay_secret_pending 取自 20261101230000_secret_link.sql；
--    asn_relay_secret_reply 取自 20261023060000_secret_remote.sql）。
-- 部署順序：先把 Edge（account）換回舊版，再跑這支。
begin;
drop function if exists public.asn_setup_request(uuid, text, text, text, text, text, text, text);
alter table relay.setup_requests drop column if exists requester_phone;
alter table relay.secret_requests drop column if exists target_node;

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
  -- 重新登入要夠新的 ASN（0.2.27 起）：舊版看不懂，會當成安裝；不建立請求
  if p_mode = 'relogin' and not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - interval '3 minutes' and relay.setup_relogin_version_ok(version)) then
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
  -- 重新登入不交給 0.2.27 以前的 ASN（它們會當成安裝）：標成失敗，讓手機看得到原因
  if v_r.mode = 'relogin' and not relay.setup_relogin_version_ok(p_version) then
    update relay.setup_requests set status = 'failed', detail = '這台電腦的 ASN 版本太舊，不支援從手機重新登入，請先更新 ASN', updated_at = now() where node = p_node;
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

create or replace function public.asn_relay_setup_result(p_node text, p_ok boolean, p_detail text, p_replaced text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_detail text := left(regexp_replace(coalesce(p_detail, ''), '[[:cntrl:]]', ' ', 'g'), 200);
  v_replaced text := left(regexp_replace(coalesce(p_replaced, ''), '[[:cntrl:]]', ' ', 'g'), 200);
begin
  if p_ok is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.setup_requests
     set status = case when p_ok then 'done' else 'failed' end,
         detail = nullif(btrim(v_detail), ''), replaced = nullif(btrim(v_replaced), ''), updated_at = now()
   where node = p_node and status = 'taken';
  return jsonb_build_object('ok', true);
end;
$function$;

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

create or replace function public.asn_relay_secret_pending(p_actor text, p_signed_user uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_out jsonb;
begin
  perform public.asn_relay_secret_purge();
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'node', r.requester_node, 'node_name', (select n.name from relay.nodes n where n.id = r.requester_node),
      'program', r.program, 'purpose', r.purpose, 'pub', r.pub, 'link', r.link, 'created_at', r.created_at, 'expires_at', r.expires_at,
      'seconds_left', greatest(0, floor(extract(epoch from (r.expires_at - now()))))::int)
      order by r.created_at), '[]'::jsonb)
    into v_out from relay.secret_requests r
    where r.owner_user = p_signed_user and r.status = 'pending' and r.expires_at > now()
      and public.asn_user_owns_node(p_signed_user, r.requester_node);
  return jsonb_build_object('requests', v_out);
end;
$function$;

create or replace function public.asn_relay_secret_reply(p_actor text, p_signed_user uuid, p_id uuid, p_cipher text, p_deny boolean)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_row relay.secret_requests;
  v_topic text;
begin
  perform public.asn_relay_secret_purge();
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_id is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not coalesce(p_deny, false) and (p_cipher is null or char_length(p_cipher) not between 100 and 2048 or p_cipher !~ '^[A-Za-z0-9_-]+$') then
    return jsonb_build_object('error', 'bad_cipher');
  end if;
  select * into v_row from relay.secret_requests
    where id = p_id and owner_user = p_signed_user and public.asn_user_owns_node(p_signed_user, requester_node)
    for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_row.expires_at <= now() then
    return jsonb_build_object('error', 'expired');
  end if;
  if v_row.status <> 'pending' then
    return jsonb_build_object('error', 'already_answered');
  end if;
  update relay.secret_requests
    set status = case when coalesce(p_deny, false) then 'denied' else 'answered' end,
        cipher = case when coalesce(p_deny, false) then null else p_cipher end,
        responder_node = p_actor, answered_at = now()
    where id = p_id;
  select bell_topic into v_topic from relay.nodes where id = v_row.requester_node;
  return jsonb_build_object('ok', true, 'bell_topic', v_topic);
end;
$function$;

commit;
