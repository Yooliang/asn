-- 遠端切換 Claude 帳號（ASN 帳號管理）。權杖絕不進收發室：這裡只存 email、方案、是否使用中，和一張「切換指令」表。
--
-- 流程：
--   1. 每台 ASN 定期回報自己帳號庫的清單（節點取自金鑰，只能寫自己的）→ relay.asn_accounts
--   2. 擁有者（role = 'owner'）節點可看同租戶別台的清單，並送出「切換帳號」指令（只帶目標 email）→ relay.account_switches
--      送出前檢查：同租戶、對方 ASN 在線（3 分鐘內有回報）、email 在對方最近一次回報的清單裡、每台每小時最多 10 次
--   3. 對方 ASN 取走自己的待辦（pending → taken）、本機確認後搬檔，再回報結果（ok／failed／denied）
--   4. 發起端查自己送出的指令結果
-- 逾時：pending 3 分鐘沒被取走 → failed；taken 10 分鐘沒回報（使用者沒按確認）→ failed。
-- 判定「擁有者」的方式與 irori_relay_launch 相同（relay.nodes.role = 'owner' 且 active），不另開一套。
begin;

create table relay.asn_accounts (
  node text not null,
  accounts jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  constraint asn_accounts_pkey primary key (node),
  constraint asn_accounts_node_fkey foreign key (node) references relay.nodes(id),
  constraint asn_accounts_array_check check (jsonb_typeof(accounts) = 'array' and jsonb_array_length(accounts) <= 20)
);
alter table relay.asn_accounts enable row level security;
revoke all on relay.asn_accounts from public, anon, authenticated;

create table relay.account_switches (
  id uuid not null default gen_random_uuid(),
  tenant_id uuid not null,
  requested_by text not null,
  node text not null,
  vendor text not null default 'claude',
  email text not null,
  status text not null default 'pending',
  detail text,
  created_at timestamptz not null default now(),
  taken_at timestamptz,
  done_at timestamptz,
  constraint account_switches_pkey primary key (id),
  constraint account_switches_vendor_check check (vendor = 'claude'),
  constraint account_switches_email_check check (char_length(email) between 3 and 120 and email = lower(email)),
  constraint account_switches_status_check check (status = any (array['pending','taken','ok','failed','denied'])),
  constraint account_switches_node_fkey foreign key (node) references relay.nodes(id),
  constraint account_switches_node_same_tenant foreign key (tenant_id, node) references relay.nodes(tenant_id, id),
  constraint account_switches_requested_by_fkey foreign key (requested_by) references relay.nodes(id),
  constraint account_switches_requester_same_tenant foreign key (tenant_id, requested_by) references relay.nodes(tenant_id, id),
  constraint account_switches_tenant_id_fkey foreign key (tenant_id) references relay.tenants(id)
);
create index account_switches_node_idx on relay.account_switches (node, created_at);
create index account_switches_requester_idx on relay.account_switches (requested_by, created_at);
alter table relay.account_switches enable row level security;
revoke all on relay.account_switches from public, anon, authenticated;

-- email 格式：小寫、一個 @、兩邊都有字、不含空白／控制字元／檔名禁用字元（跟 ASN 的 normalize_email 同一條規則）
create or replace function public.irori_relay_acct_email_ok(p_email text)
 returns boolean
 language sql
 immutable
 set search_path to ''
as $function$
  select p_email is not null
    and p_email = lower(p_email)
    and char_length(p_email) between 3 and 120
    and p_email ~ '^[^@[:space:][:cntrl:]/:*?"<>|\\]+@[^@[:space:][:cntrl:]/:*?"<>|\\]+$';
$function$;

-- 逾時處理（每次取待辦、查結果時順便做）
create or replace function public.irori_relay_acct_expire()
 returns void
 language sql
 security definer
 set search_path to ''
as $function$
  update relay.account_switches set status = 'failed', detail = '對方電腦 3 分鐘內沒有取走指令（ASN 可能沒開）', done_at = now()
    where status = 'pending' and created_at <= now() - interval '3 minutes';
  update relay.account_switches set status = 'failed', detail = '等不到對方電腦的確認（10 分鐘逾時）', done_at = now()
    where status = 'taken' and taken_at <= now() - interval '10 minutes';
$function$;

-- 回報帳號清單：只留 vendor／email／plan／current 四個欄位，最多 20 筆；整份取代
create or replace function public.irori_relay_acct_report(p_node text, p_accounts jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_row jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  if p_accounts is null or jsonb_typeof(p_accounts) <> 'array' or jsonb_array_length(p_accounts) > 20 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active') then
    return jsonb_build_object('error', 'not_found');
  end if;
  for v_row in select * from jsonb_array_elements(p_accounts) loop
    if jsonb_typeof(v_row) <> 'object'
       or v_row->>'vendor' is distinct from 'claude'
       or not public.irori_relay_acct_email_ok(v_row->>'email')
       or (v_row ? 'plan' and (jsonb_typeof(v_row->'plan') <> 'string' or char_length(v_row->>'plan') > 30 or (v_row->>'plan') ~ '[[:cntrl:]]'))
       or (v_row ? 'current' and jsonb_typeof(v_row->'current') <> 'boolean') then
      return jsonb_build_object('error', 'bad_request');
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'vendor', 'claude', 'email', v_row->>'email', 'plan', coalesce(v_row->>'plan', ''), 'current', coalesce((v_row->>'current')::boolean, false)));
  end loop;
  insert into relay.asn_accounts (node, accounts, updated_at) values (p_node, v_out, now())
    on conflict (node) do update set accounts = excluded.accounts, updated_at = excluded.updated_at;
  return jsonb_build_object('ok', true, 'count', jsonb_array_length(v_out));
end;
$function$;

-- 擁有者看同租戶別台的帳號清單（只有 email、方案、使用中）
create or replace function public.irori_relay_acct_list(p_actor text, p_node text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_t uuid;
  v_a jsonb;
  v_at timestamptz;
  v_online boolean;
begin
  select tenant_id into v_t from relay.nodes where id = p_actor and role = 'owner' and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active' and tenant_id is not distinct from v_t) then
    return jsonb_build_object('error', 'not_found');
  end if;
  select accounts, updated_at into v_a, v_at from relay.asn_accounts where node = p_node;
  select exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - interval '3 minutes') into v_online;
  return jsonb_build_object('node', p_node, 'accounts', coalesce(v_a, '[]'::jsonb), 'reported_at', v_at, 'asn_online', v_online);
end;
$function$;

-- 擁有者送出「切換帳號」指令。指令只帶目標 email；成功回指令編號與門鈴
create or replace function public.irori_relay_acct_switch(p_actor text, p_node text, p_vendor text, p_email text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_t uuid;
  v_topic text;
  v_id uuid;
begin
  select tenant_id into v_t from relay.nodes where id = p_actor and role = 'owner' and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select bell_topic into v_topic from relay.nodes where id = p_node and status = 'active' and tenant_id is not distinct from v_t;
  if v_topic is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_vendor is distinct from 'claude' then
    return jsonb_build_object('error', 'bad_vendor');
  end if;
  if not public.irori_relay_acct_email_ok(p_email) then
    return jsonb_build_object('error', 'bad_email');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - interval '3 minutes') then
    return jsonb_build_object('error', 'asn_offline');
  end if;
  if not exists (select 1 from relay.asn_accounts a, jsonb_array_elements(a.accounts) e where a.node = p_node and e->>'email' = p_email) then
    return jsonb_build_object('error', 'unknown_account');
  end if;
  perform public.irori_relay_acct_expire();
  if exists (select 1 from relay.account_switches where node = p_node and status in ('pending', 'taken')) then
    return jsonb_build_object('error', 'busy');
  end if;
  if (select count(*) from relay.account_switches where node = p_node and created_at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.account_switches (tenant_id, requested_by, node, vendor, email)
    values (v_t, p_actor, p_node, p_vendor, p_email) returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

-- 目標 ASN 取走自己的待辦（只動得到自己節點的）
create or replace function public.irori_relay_acct_switch_pending(p_node text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_out jsonb;
begin
  perform public.irori_relay_acct_expire();
  with t as (
    update relay.account_switches set status = 'taken', taken_at = now()
      where node = p_node and status = 'pending'
      returning id, requested_by, vendor, email, created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'requested_by', t.requested_by, 'vendor', t.vendor, 'email', t.email, 'created_at', t.created_at) order by t.created_at), '[]'::jsonb)
    into v_out from t;
  return jsonb_build_object('requests', v_out);
end;
$function$;

-- 目標 ASN 回報結果（只能回報自己節點、已被取走的指令）
create or replace function public.irori_relay_acct_switch_result(p_node text, p_id uuid, p_status text, p_detail text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_n int;
begin
  if p_status is null or p_status not in ('ok', 'failed', 'denied') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.account_switches set status = p_status, detail = left(regexp_replace(coalesce(p_detail, ''), '[[:cntrl:]]', ' ', 'g'), 300), done_at = now()
    where id = p_id and node = p_node and status = 'taken';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

-- 發起端查自己送出的指令結果（只看得到自己送的）
create or replace function public.irori_relay_acct_switch_status(p_actor text, p_ids uuid[])
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_out jsonb;
begin
  if p_ids is null or coalesce(array_length(p_ids, 1), 0) > 20 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  perform public.irori_relay_acct_expire();
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'node', s.node, 'email', s.email, 'status', s.status, 'detail', s.detail, 'created_at', s.created_at, 'done_at', s.done_at) order by s.created_at), '[]'::jsonb)
    into v_out from relay.account_switches s where s.requested_by = p_actor and s.id = any (p_ids);
  return jsonb_build_object('switches', v_out);
end;
$function$;

revoke all on function public.irori_relay_acct_email_ok(text) from public, anon, authenticated;
revoke all on function public.irori_relay_acct_expire() from public, anon, authenticated;
revoke all on function public.irori_relay_acct_report(text, jsonb) from public, anon, authenticated;
revoke all on function public.irori_relay_acct_list(text, text) from public, anon, authenticated;
revoke all on function public.irori_relay_acct_switch(text, text, text, text) from public, anon, authenticated;
revoke all on function public.irori_relay_acct_switch_pending(text) from public, anon, authenticated;
revoke all on function public.irori_relay_acct_switch_result(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.irori_relay_acct_switch_status(text, uuid[]) from public, anon, authenticated;
grant execute on function public.irori_relay_acct_email_ok(text) to service_role;
grant execute on function public.irori_relay_acct_expire() to service_role;
grant execute on function public.irori_relay_acct_report(text, jsonb) to service_role;
grant execute on function public.irori_relay_acct_list(text, text) to service_role;
grant execute on function public.irori_relay_acct_switch(text, text, text, text) to service_role;
grant execute on function public.irori_relay_acct_switch_pending(text) to service_role;
grant execute on function public.irori_relay_acct_switch_result(text, uuid, text, text) to service_role;
grant execute on function public.irori_relay_acct_switch_status(text, uuid[]) to service_role;

-- 90 天清理：每天 03:37（UTC）刪掉 90 天前的指令紀錄與 90 天沒回報的帳號清單
create extension if not exists pg_cron;
select cron.unschedule('asn-account-switch-purge-90d') where exists (select 1 from cron.job where jobname = 'asn-account-switch-purge-90d');
select cron.schedule('asn-account-switch-purge-90d', '37 3 * * *', $$
  delete from relay.account_switches where created_at < now() - interval '90 days';
  delete from relay.asn_accounts where updated_at < now() - interval '90 days';
$$);

commit;
