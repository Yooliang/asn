-- 遠端更新：已登入的本人在名單對自己帳號下的別台設備按「更新」，後台留一筆更新請求；
-- 那台 ASN 在回報在線狀態（asn_presence，每 60 秒）時讀到旗標，用內建更新器自己下載、驗簽、安裝、重開。全程不經 AI。
--
-- 流程：
--   1. 本人（登入憑證）送出請求：只有 relay.nodes.owner_user = 本人 的節點可以；對方 ASN 要在線（3 分鐘內有回報）
--   2. 對方 ASN 回報在線時順便取走請求（pending → taken，記下當時版本），開始更新
--   3. 更新成功＝重開後回報的版本跟取走時不同 → 請求自動清掉；已是最新版／更新失敗由對方回報結果（清掉／failed）
--   4. 請求 30 分鐘沒完成就當作過期（不再觸發、狀態不再顯示）
-- 每個節點同時最多一筆請求（主鍵 node）；failed 後 1 分鐘內不能重送。
begin;

create table relay.asn_update_requests (
  node text not null,
  requested_by uuid not null,
  status text not null default 'pending',
  from_version text,
  detail text,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint asn_update_requests_pkey primary key (node),
  constraint asn_update_requests_node_fkey foreign key (node) references relay.nodes(id),
  constraint asn_update_requests_status_check check (status in ('pending', 'taken', 'failed')),
  constraint asn_update_requests_detail_check check (detail is null or char_length(detail) <= 200)
);
alter table relay.asn_update_requests enable row level security;
revoke all on relay.asn_update_requests from public, anon, authenticated;

-- 本人送出更新請求（身分由登入憑證驗證，Edge Function 傳進來的 p_user）
create or replace function public.asn_update_request(p_user uuid, p_node text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_r relay.asn_update_requests%rowtype;
begin
  -- 不是自己的節點、或節點不存在：一律 not_found（不透露別人帳號下有沒有這台）
  if p_user is null or not exists (select 1 from relay.nodes where id = p_node and status = 'active' and owner_user = p_user) then
    return jsonb_build_object('error', 'not_found');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - interval '3 minutes') then
    return jsonb_build_object('error', 'asn_offline');
  end if;
  select * into v_r from relay.asn_update_requests where node = p_node for update;
  if found and v_r.status in ('pending', 'taken') and v_r.requested_at > now() - interval '30 minutes' then
    return jsonb_build_object('ok', true, 'already', true, 'state', v_r.status);
  end if;
  if found and v_r.status = 'failed' and v_r.updated_at > now() - interval '1 minute' then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.asn_update_requests (node, requested_by, status, from_version, detail, requested_at, updated_at)
    values (p_node, p_user, 'pending', null, null, now(), now())
  on conflict (node) do update
    set requested_by = excluded.requested_by, status = 'pending', from_version = null, detail = null,
        requested_at = excluded.requested_at, updated_at = excluded.updated_at;
  insert into relay.account_events (user_id, event, node) values (p_user, 'update_requested', p_node);
  return jsonb_build_object('ok', true, 'already', false, 'state', 'pending');
end;
$function$;
revoke all on function public.asn_update_request(uuid, text) from public, anon, authenticated;
grant execute on function public.asn_update_request(uuid, text) to service_role;

-- 本人看自己帳號下各節點的更新狀態（也是「哪些設備是我的」）。過期的請求不顯示
create or replace function public.asn_update_status(p_user uuid)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id,
    'update', case when r.node is null or r.requested_at <= now() - interval '30 minutes' then null
                   else jsonb_build_object('state', r.status, 'detail', r.detail, 'at', r.requested_at) end
  ) order by n.id), '[]'::jsonb)
  from relay.nodes n left join relay.asn_update_requests r on r.node = n.id
  where n.owner_user = p_user and n.status = 'active';
$function$;
revoke all on function public.asn_update_status(uuid) from public, anon, authenticated;
grant execute on function public.asn_update_status(uuid) to service_role;

-- ASN 回報在線時順便問：有沒有要我更新？（節點取自金鑰，只動自己的）
-- pending → taken 並回 true（只回一次，所以不會重複啟動）；taken 後版本變了＝更新成功，清掉請求
create or replace function public.irori_relay_asn_update_poll(p_node text, p_version text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_r relay.asn_update_requests%rowtype;
begin
  delete from relay.asn_update_requests where node = p_node and requested_at <= now() - interval '30 minutes';
  select * into v_r from relay.asn_update_requests where node = p_node for update;
  if not found then
    return jsonb_build_object('requested', false);
  end if;
  if v_r.status = 'pending' then
    update relay.asn_update_requests set status = 'taken', from_version = p_version, updated_at = now() where node = p_node;
    return jsonb_build_object('requested', true);
  end if;
  if v_r.status = 'taken' and v_r.from_version is distinct from p_version then
    delete from relay.asn_update_requests where node = p_node;
  end if;
  return jsonb_build_object('requested', false);
end;
$function$;
revoke all on function public.irori_relay_asn_update_poll(text, text) from public, anon, authenticated;
grant execute on function public.irori_relay_asn_update_poll(text, text) to service_role;

-- 對方 ASN 回報結果：ok（例如已經是最新版）＝清掉請求；失敗＝記成 failed 與原因（≤ 200 字）。只動自己節點、只處理 taken 的那筆
create or replace function public.irori_relay_asn_update_result(p_node text, p_ok boolean, p_detail text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_detail text := left(regexp_replace(coalesce(p_detail, ''), '[[:cntrl:]]', ' ', 'g'), 200);
begin
  if p_ok is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if p_ok then
    delete from relay.asn_update_requests where node = p_node and status = 'taken';
  else
    update relay.asn_update_requests set status = 'failed', detail = nullif(btrim(v_detail), ''), updated_at = now()
      where node = p_node and status = 'taken';
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;
revoke all on function public.irori_relay_asn_update_result(text, boolean, text) from public, anon, authenticated;
grant execute on function public.irori_relay_asn_update_result(text, boolean, text) to service_role;

-- 清理：超過 1 天沒動的列每天 03:29（UTC）刪掉
create extension if not exists pg_cron;
select cron.unschedule('asn-update-requests-purge') where exists (select 1 from cron.job where jobname = 'asn-update-requests-purge');
select cron.schedule('asn-update-requests-purge', '29 3 * * *', $$
  delete from relay.asn_update_requests where updated_at < now() - interval '1 day';
$$);

commit;
