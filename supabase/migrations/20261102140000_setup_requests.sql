-- 【獨立區塊】手機替新電腦「安裝並登入 Claude Code」的遠端請求（#628 第 4b 段）。
-- 與 20261101230000_secret_link.sql 分開，審查可各自看、各自回復。設計見 docs/design/SECRET-REMOTE.md 與 #628。
--
-- 流程（沿用遠端更新 20261021070000_asn_remote_update.sql 的做法）：
--   1. 本人（登入憑證）在手機上對自己帳號下的一台電腦送出請求：節點必須是 relay.nodes.owner_user = 本人，且那台 ASN 在線（3 分鐘內有回報）。
--   2. 那台 ASN 回報在線時順便取走請求（pending → taken），取走時一併得到「誰送的」；ASN 自己登入的帳號必須是同一個人才會做。
--   3. ASN 做完回報結果（done／failed，固定欄位）；手機用 status 看進度與結果。
--   4. pending 超過 10 分鐘沒被取走就過期；taken 超過 40 分鐘沒回報（安裝最長 15 分鐘加登入 10 分鐘）當作失敗過期。
-- 限制：每個節點同時只有一筆（主鍵 node）；同一使用者每小時最多建立 6 次；失敗後 1 分鐘內不能重送。
-- 這個功能本身是否生效還要看那台電腦的本機開關（預設關）；開關存在一般設定檔、夥伴 AI 也寫得到，所以不是唯一防線——
-- 主要防線是這裡：請求只能由登入憑證的本人建立，節點金鑰（AI 視窗拿得到的）建立不了。
--
-- security definer 函式碰到的資料表（全部 set search_path to ''、只授權 service_role）：
--   relay.setup_version_ok(p_version)      純函式，不碰資料表：版本（數字比，不是字串比；0.2.10 > 0.2.2）是否支援這個功能（0.2.2 起）
--   asn_setup_request(p_user, p_node)      讀 relay.nodes、relay.asn_presence（在線且版本夠新才准）；讀寫 relay.setup_requests；寫 relay.account_events（稽核與頻率上限）
--   asn_setup_status(p_user)               讀 relay.nodes、relay.setup_requests
--   asn_relay_setup_poll(p_node, p_version) 只動 relay.setup_requests 裡 node = p_node 的那一列（節點取自金鑰）；版本太舊的 ASN 不交給它
--   asn_relay_setup_result(p_node, ...)    只動 relay.setup_requests 裡 node = p_node 且 status = 'taken' 的那一列
-- 沒有改既有資料表、沒有改既有函式。
-- 部署順序：本 migration → relay（Edge Function，新動作）→ 發新版 ASN。提早上任何一步都不會壞（舊 Edge 沒有這些動作，回 404）。
-- 回復：supabase/sql/rollback/20261102140000_setup_requests_down.sql（drop 這四支函式與一張表，已送出的登入網址請求不受影響）。
-- 版本太舊的 ASN（現在全部都是）看不懂這個功能：不能把請求交給它（會標成 taken 卻不做，手機要等 40 分鐘）。
-- 建立時就說 asn_outdated，手機提示先更新；取走時版本不夠的也不交。
begin;

create or replace function relay.setup_version_ok(p_version text)
 returns boolean language sql immutable set search_path to ''
as $function$
  select coalesce(p_version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}', false)
     and string_to_array(substring(p_version from '^[0-9]+\.[0-9]+\.[0-9]+'), '.')::int[] >= array[0, 2, 2];
$function$;
revoke all on function relay.setup_version_ok(text) from public, anon, authenticated;

create table relay.setup_requests (
  node text not null,
  requested_by uuid not null,
  kind text not null default 'claude',
  status text not null default 'pending',
  detail text,
  replaced text,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint setup_requests_pkey primary key (node),
  constraint setup_requests_node_fkey foreign key (node) references relay.nodes(id),
  constraint setup_requests_kind_check check (kind in ('claude')),
  constraint setup_requests_status_check check (status in ('pending', 'taken', 'done', 'failed')),
  constraint setup_requests_detail_check check (detail is null or char_length(detail) <= 200),
  constraint setup_requests_replaced_check check (replaced is null or char_length(replaced) <= 200)
);
alter table relay.setup_requests enable row level security;
revoke all on relay.setup_requests from public, anon, authenticated;

-- 本人送出請求（身分由登入憑證驗證，Edge Function 傳進來的 p_user）
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

-- 本人看自己帳號下各節點的請求狀態（手機顯示進度與結果）。過期的 pending 不顯示
create or replace function public.asn_setup_status(p_user uuid)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id,
    'setup', case
      when r.node is null then null
      when r.status = 'pending' and r.requested_at <= now() - interval '10 minutes' then null
      when r.status = 'taken' and r.updated_at <= now() - interval '40 minutes' then jsonb_build_object('state', 'failed', 'detail', '電腦沒有回報結果，已逾時', 'replaced', null, 'at', r.updated_at)
      else jsonb_build_object('state', r.status, 'detail', r.detail, 'replaced', r.replaced, 'at', r.updated_at)
    end
  ) order by n.id), '[]'::jsonb)
  from relay.nodes n left join relay.setup_requests r on r.node = n.id
  where n.owner_user = p_user and n.status = 'active';
$function$;
revoke all on function public.asn_setup_status(uuid) from public, anon, authenticated;
grant execute on function public.asn_setup_status(uuid) to service_role;

-- ASN 回報在線時順便問：有沒有要我替這台安裝並登入？（節點取自金鑰，只動自己的）
-- pending → taken 並回 requested＋送出者的使用者代號（只回一次，所以不會重複啟動；ASN 要比對自己登入的是不是同一個人）
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
revoke all on function public.asn_relay_setup_poll(text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_setup_poll(text, text) to service_role;

-- 對方 ASN 回報結果：ok＝完成；否則 failed 與原因（固定句子，≤ 200 字）。p_replaced＝這次重裝了壞掉的 claude.exe 的說明（選填，≤ 200 字）。
-- 只動自己節點、只處理 taken 的那一列
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
revoke all on function public.asn_relay_setup_result(text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_setup_result(text, boolean, text, text) to service_role;

-- 清理：超過 1 天沒動的列每天 03:41（UTC）刪掉
create extension if not exists pg_cron;
select cron.unschedule('asn-setup-requests-purge') where exists (select 1 from cron.job where jobname = 'asn-setup-requests-purge');
select cron.schedule('asn-setup-requests-purge', '41 3 * * *', $$
  delete from relay.setup_requests where updated_at < now() - interval '1 day';
$$);

commit;
