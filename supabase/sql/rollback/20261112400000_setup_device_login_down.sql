-- 回復 20261112400000_setup_device_login.sql：
--   刪掉非 claude 的請求（不然 kind 約束加不回去）、drop 新函式與新欄位、asn_setup_request／asn_relay_setup_poll／asn_relay_secret_request_link
--   與 link 約束換回原文（逐字取自 20261102170000_node_platform_phone.sql 與 20261101230000_secret_link.sql）。
--   換回 link 約束之前，先把不合舊規則的登入網址清成空。
-- 部署順序：先把 Edge（relay、account）換回舊版，再跑這支。
begin;
delete from relay.setup_requests where kind <> 'claude';
drop function if exists public.asn_setup_code_fetch(uuid, text);
drop function if exists public.asn_relay_setup_code_put(text, text, text, text, text);
drop function if exists public.asn_setup_request(uuid, text, text, text, text, text);
alter table relay.setup_requests drop constraint if exists setup_requests_device_ck;
alter table relay.setup_requests drop constraint if exists setup_requests_rid_key;
alter table relay.setup_requests
  drop column if exists rid, drop column if exists req_payload, drop column if exists req_sig, drop column if exists req_p_node,
  drop column if exists t_eph_pub, drop column if exists cipher, drop column if exists t_sig, drop column if exists cipher_put_at,
  drop column if exists delivered_at, drop column if exists expires_at;
alter table relay.setup_requests drop constraint if exists setup_requests_kind_check;
alter table relay.setup_requests add constraint setup_requests_kind_check check (kind in ('claude'));
drop function if exists relay.setup_kind_version_ok(text, text);

create or replace function public.asn_setup_request(p_user uuid, p_node text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_r relay.setup_requests%rowtype;
begin
  -- 不是自己的節點、或節點不存在：一律 not_found（不透露別人帳號下有沒有這台）
  if p_user is null or not exists (select 1 from relay.nodes where id = p_node and status = 'active' and owner_user = p_user) then
    return jsonb_build_object('error', 'not_found');
  end if;
  -- 手機（安卓／iOS）不能被安裝：沒有電腦那一套（asn真 清單第 2 點）。平台是空的（舊版或機器橋沒回報）照舊當電腦
  if exists (select 1 from relay.nodes where id = p_node and platform in ('android', 'ios')) then
    return jsonb_build_object('error', 'unsupported_platform');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - interval '3 minutes') then
    return jsonb_build_object('error', 'asn_offline');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - interval '3 minutes' and relay.setup_version_ok(version)) then
    return jsonb_build_object('error', 'asn_outdated');
  end if;
  perform pg_advisory_xact_lock(hashtext('setup_request:' || p_user::text));
  select * into v_r from relay.setup_requests where node = p_node for update;
  if found and ((v_r.status = 'pending' and v_r.requested_at > now() - interval '10 minutes')
             or (v_r.status = 'taken' and v_r.updated_at > now() - interval '40 minutes')) then
    return jsonb_build_object('ok', true, 'already', true, 'state', v_r.status);
  end if;
  if found and v_r.status = 'failed' and v_r.updated_at > now() - interval '1 minute' then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  if (select count(*) from relay.account_events where user_id = p_user and event = 'setup_requested' and at > now() - interval '1 hour') >= 6 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.setup_requests (node, requested_by, kind, status, detail, replaced, requested_at, updated_at)
    values (p_node, p_user, 'claude', 'pending', null, null, now(), now())
  on conflict (node) do update
    set requested_by = excluded.requested_by, kind = 'claude', status = 'pending', detail = null, replaced = null,
        requested_at = excluded.requested_at, updated_at = excluded.updated_at;
  insert into relay.account_events (user_id, event, node) values (p_user, 'setup_requested', p_node);
  return jsonb_build_object('ok', true, 'already', false, 'state', 'pending');
end;
$function$;
revoke all on function public.asn_setup_request(uuid, text) from public, anon, authenticated;
grant execute on function public.asn_setup_request(uuid, text) to service_role;

create or replace function public.asn_relay_setup_poll(p_node text, p_version text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_r relay.setup_requests%rowtype;
begin
  -- 過期的 pending 直接清掉；taken 太久沒回報的標成失敗，讓手機看得到
  delete from relay.setup_requests where node = p_node and status = 'pending' and requested_at <= now() - interval '10 minutes';
  update relay.setup_requests set status = 'failed', detail = '電腦沒有回報結果，已逾時', updated_at = now()
    where node = p_node and status = 'taken' and updated_at <= now() - interval '40 minutes';
  -- 手機不交（沒有電腦那一套會把請求標成 taken 卻不做）；平台是空的照舊當電腦
  if exists (select 1 from relay.nodes where id = p_node and platform in ('android', 'ios')) then
    return jsonb_build_object('requested', false);
  end if;
  -- 版本不夠新的 ASN 看不懂這個功能，不交給它（請求留著，等夠新的視窗來取，或 10 分鐘後過期）
  if not relay.setup_version_ok(p_version) then
    return jsonb_build_object('requested', false);
  end if;
  select * into v_r from relay.setup_requests where node = p_node for update;
  if not found or v_r.status <> 'pending' then
    return jsonb_build_object('requested', false);
  end if;
  update relay.setup_requests set status = 'taken', updated_at = now() where node = p_node;
  return jsonb_build_object('requested', true, 'requested_by', v_r.requested_by, 'kind', v_r.kind);
end;
$function$;

-- 已存的 Codex／Grok 登入網址（只是網址欄，不是密碼）不合舊規則：先清成空，否則下面加回約束會失敗
update relay.secret_requests set link = null
 where link is not null
   and link !~ '^https://([a-z0-9-]+\.)*(claude\.ai|claude\.com|anthropic\.com)(:443)?([/?#][\x21-\x5b\x5d-\x7e]*)?$';
alter table relay.secret_requests drop constraint if exists secret_requests_link_ck;
alter table relay.secret_requests add constraint secret_requests_link_ck check (
  link is null or (
    char_length(link) between 12 and 2048
    and link ~ '^https://([a-z0-9-]+\.)*(claude\.ai|claude\.com|anthropic\.com)(:443)?([/?#][\x21-\x5b\x5d-\x7e]*)?$'
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
     or p_link !~ '^https://([a-z0-9-]+\.)*(claude\.ai|claude\.com|anthropic\.com)(:443)?([/?#][\x21-\x5b\x5d-\x7e]*)?$' then
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

commit;
