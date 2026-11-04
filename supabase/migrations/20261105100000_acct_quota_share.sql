-- 額度查詢（todo-next-193，後台第一張）：帳號列表多收 Grok、MiniMax，並讓本人替單一帳號開免登入的查詢代碼。
--
-- 這支做的事：
--  1. relay.asn_user_accounts 多兩欄 share_hash、share_created_at（預設空＝不對外）；廠牌檢查加 minimax。
--  2. relay.asn_quota_read_hits：查詢次數，每個來源每小時一列，舊列隨新列清掉。
--  3. asn_relay_acct_window_judge：MiniMax 比照 Gemini，現記的那窗是 100% 就照收新的。沒用過的窗，MiniMax 每次給的重置時間都是「現在＋整個窗長」（11-05 實測），不加這條，開始用之後新數字會被判 later_not_expired。其餘與 20261029130000 版逐字相同。
--     asn_relay_acct_windows_clean：收 grok（只收 weekly）、minimax（只收 five_hour、weekly）。其餘與 20261029130000 版逐字相同。
--  4. asn_relay_acct_roster_report：廠牌加 minimax；grok 不再固定清空窗；minimax 比照 gemini 記哪台在用。其餘與 20261031100000 版逐字相同。
--  5. asn_relay_acct_roster：多回 shared（有沒有開代碼，不回代碼本身）；minimax 的 nodes 比照 gemini。其餘與 20261031100000 版逐字相同。
--  6. 新函式 asn_relay_quota_read（查詢）、asn_relay_acct_share_set（本人開或撤代碼）。
--
-- 舊用戶端不受影響：舊表 relay.asn_accounts、舊函式 asn_relay_acct_report 不動；舊用戶端不回報 minimax，也不帶 grok 的窗，行為與現在相同；
-- roster 多一個欄位，舊畫面不讀。
-- 權限：對 public／anon／authenticated 收回，只給 service_role；security definer、search_path 空。
-- 部署順序：本 migration → relay（Edge Function）→ 電腦端。先上 migration 時舊 relay 照常運作。
-- 回復：supabase/sql/rollback/20261105100000_acct_quota_share_down.sql（會刪 minimax 帳號列、清 grok 的窗、所有代碼失效）。
begin;

alter table relay.asn_user_accounts drop constraint if exists asn_user_accounts_vendor_check;
alter table relay.asn_user_accounts add constraint asn_user_accounts_vendor_check check (vendor in ('claude', 'codex', 'grok', 'gemini', 'minimax'));
alter table relay.asn_user_accounts add column if not exists share_hash text;
alter table relay.asn_user_accounts add column if not exists share_created_at timestamptz;
alter table relay.asn_user_accounts drop constraint if exists asn_user_accounts_share_hash_check;
alter table relay.asn_user_accounts add constraint asn_user_accounts_share_hash_check check (share_hash is null or share_hash ~ '^[0-9a-f]{64}$');
create unique index if not exists asn_user_accounts_share_hash_idx on relay.asn_user_accounts (share_hash) where share_hash is not null;

create table if not exists relay.asn_quota_read_hits (
  ip_hash text not null,
  bucket timestamptz not null,
  hits int not null default 0,
  misses int not null default 0,
  constraint asn_quota_read_hits_pkey primary key (ip_hash, bucket)
);
create index if not exists asn_quota_read_hits_bucket_idx on relay.asn_quota_read_hits (bucket);
alter table relay.asn_quota_read_hits enable row level security;
revoke all on relay.asn_quota_read_hits from public, anon, authenticated;

create or replace function public.asn_relay_acct_window_judge(p_vendor text, p_name text, p_old jsonb, p_new jsonb, p_now timestamptz)
 returns text
 language plpgsql
 stable
 set search_path to ''
as $function$
declare
  v_old_r timestamptz;
  v_new_r timestamptz;
  v_diff numeric;
  v_k numeric;
begin
  if jsonb_typeof(p_new->'resets_at') = 'string' then
    v_new_r := (p_new->>'resets_at')::timestamptz;
    if v_new_r < p_now - interval '1 day' or v_new_r > p_now + interval '8 days' then
      return 'reset_out_of_range';
    end if;
  end if;
  -- Gemini 現記的是 100%（沒用過的桶，agy 給的重置時間每次都是「現在＋整個窗長」、一直往後跑）：照收新的（#1519）
  if p_vendor in ('gemini', 'minimax') and p_old is not null and jsonb_typeof(p_old->'left_pct') = 'number' and (p_old->>'left_pct')::numeric = 100 then
    return null;
  end if;
  if p_old is null or jsonb_typeof(p_old->'resets_at') is distinct from 'string' or v_new_r is null then
    return null;
  end if;
  v_old_r := (p_old->>'resets_at')::timestamptz;
  if v_old_r > p_now + interval '8 days' then
    return null;
  end if;
  if p_now > v_old_r + interval '7 days' then
    return null;
  end if;
  v_diff := extract(epoch from v_new_r - v_old_r);
  if abs(v_diff) <= 600 then
    return case when (p_new->>'left_pct')::int <= (p_old->>'left_pct')::int then null else 'same_period_rise' end;
  end if;
  if v_diff < 0 then
    return 'earlier';
  end if;
  if v_old_r > p_now then
    return 'later_not_expired';
  end if;
  if p_vendor = 'claude' and p_name = 'weekly' then
    v_k := floor((v_diff + 302400) / 604800);
    if v_k < 1 or abs(v_diff - v_k * 604800) > 600 then
      return 'not_week_multiple';
    end if;
  end if;
  return null;
end;
$function$;

create or replace function public.asn_relay_acct_windows_clean(p_vendor text, p_windows jsonb, p_node text, p_now timestamptz)
 returns jsonb
 language plpgsql
 stable
 set search_path to ''
as $function$
declare
  v_w jsonb;
  v_name text;
  v_read text;
  v_reset text;
  v_out jsonb := '[]'::jsonb;
begin
  if p_vendor not in ('claude', 'codex', 'gemini', 'grok', 'minimax') or jsonb_typeof(p_windows) is distinct from 'array' then
    return '[]'::jsonb;
  end if;
  for v_w in select e from jsonb_array_elements(p_windows) with ordinality t(e, i) order by i limit 16 loop
    exit when jsonb_array_length(v_out) >= 4;
    continue when jsonb_typeof(v_w) <> 'object' or jsonb_typeof(v_w->'name') is distinct from 'string';
    v_name := v_w->>'name';
    continue when v_name !~ '^(five_hour|weekly|w[0-9]{1,6})$';
    -- Gemini 只收 five_hour、weekly（電腦端只對應 gemini-5h、gemini-weekly 兩桶，#1515）
    continue when p_vendor = 'gemini' and v_name not in ('five_hour', 'weekly');
    -- MiniMax 只有 5 小時與每週、Grok 只有每週
    continue when p_vendor = 'minimax' and v_name not in ('five_hour', 'weekly');
    continue when p_vendor = 'grok' and v_name <> 'weekly';
    v_name := case v_name when 'w300' then 'five_hour' when 'w10080' then 'weekly' else v_name end;
    continue when jsonb_typeof(v_w->'left_pct') is distinct from 'number';
    continue when (v_w->>'left_pct')::numeric not between 0 and 100;
    v_read := public.asn_relay_acct_iso(v_w->'read_at');
    continue when v_read is null or v_read::timestamptz > p_now + interval '10 minutes';
    v_reset := null;
    if v_w ? 'resets_at' and jsonb_typeof(v_w->'resets_at') <> 'null' then
      v_reset := public.asn_relay_acct_iso(v_w->'resets_at');
      continue when v_reset is null;
      continue when v_reset::timestamptz < p_now - interval '1 day' or v_reset::timestamptz > p_now + interval '8 days';
    end if;
    continue when exists (select 1 from jsonb_array_elements(v_out) o where o->>'name' = v_name);
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'name', v_name, 'left_pct', round((v_w->>'left_pct')::numeric)::int, 'resets_at', v_reset, 'read_at', v_read, 'read_node', p_node));
  end loop;
  return v_out;
end;
$function$;

create or replace function public.asn_relay_acct_roster_report(p_node text, p_accounts jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_user uuid;
  v_now timestamptz := now();
  v_row jsonb;
  v_vendor text;
  v_email text;
  v_plan text;
  v_new jsonb;
  v_merged jsonb;
  v_w jsonb;
  v_o jsonb;
  v_reason text;
  v_skipped jsonb := '[]'::jsonb;
  v_count int := 0;
  v_gemini text[] := '{}';
begin
  if p_accounts is null or jsonb_typeof(p_accounts) <> 'array' or jsonb_array_length(p_accounts) > 20 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select owner_user into v_user from relay.nodes where id = p_node and status = 'active';
  if v_user is null or not public.asn_user_owns_node(v_user, p_node) then
    return jsonb_build_object('error', 'not_claimed');
  end if;
  -- 先整份檢查（跟舊的 asn_relay_acct_report 同一套），不合格就什麼都不寫
  for v_row in select * from jsonb_array_elements(p_accounts) loop
    if jsonb_typeof(v_row) <> 'object'
       or v_row->>'vendor' is null or v_row->>'vendor' not in ('claude', 'codex', 'grok', 'gemini', 'minimax')
       or not public.asn_relay_acct_email_ok(v_row->>'email')
       or (v_row ? 'plan' and (jsonb_typeof(v_row->'plan') <> 'string' or char_length(v_row->>'plan') > 30 or (v_row->>'plan') ~ '[[:cntrl:]]'))
       or (v_row ? 'login_failed' and jsonb_typeof(v_row->'login_failed') <> 'boolean')
       or (v_row ? 'login_incomplete' and jsonb_typeof(v_row->'login_incomplete') <> 'boolean') then
      return jsonb_build_object('error', 'bad_request');
    end if;
  end loop;
  -- 依 (vendor, email) 的順序逐筆鎖，兩台電腦以相反順序回報同兩個帳號時不會互等成死結（#524 審查）
  for v_row in select e from jsonb_array_elements(p_accounts) with ordinality t(e, i) order by e->>'vendor', lower(e->>'email'), i loop
    v_vendor := v_row->>'vendor';
    v_email := v_row->>'email';
    v_plan := btrim(coalesce(v_row->>'plan', ''));
    v_new := case
      when v_row ? 'windows' then public.asn_relay_acct_windows_clean(v_vendor, v_row->'windows', p_node, v_now)
      else '[]'::jsonb end;
    -- 沒帶 windows、或帶了但清完一窗都不剩：Claude 退回舊四欄（#524 審查）
    if v_vendor = 'claude' and v_new = '[]'::jsonb then
      v_new := public.asn_relay_acct_legacy_windows(v_row, p_node);
    end if;
    insert into relay.asn_user_accounts (user_id, vendor, account, plan, seen_node)
      values (v_user, v_vendor, v_email, v_plan, p_node)
      on conflict (user_id, vendor, account) do nothing;
    select windows into v_merged from relay.asn_user_accounts
      where user_id = v_user and vendor = v_vendor and account = v_email for update;
    for v_w in select e from jsonb_array_elements(v_new) with ordinality t(e, i) order by i loop
      select e into v_o from jsonb_array_elements(v_merged) e where e->>'name' = v_w->>'name' limit 1;
      v_reason := public.asn_relay_acct_window_judge(v_vendor, v_w->>'name', v_o, v_w, v_now);
      if v_reason is not null then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('vendor', v_vendor, 'window', v_w->>'name', 'reason', v_reason));
      elsif v_o is null then
        v_merged := v_merged || jsonb_build_array(v_w);
      else
        select jsonb_agg(case when e->>'name' = v_w->>'name' then v_w else e end order by i) into v_merged
          from jsonb_array_elements(v_merged) with ordinality t(e, i);
      end if;
    end loop;
    if jsonb_array_length(v_merged) > 4 then
      select jsonb_agg(s.e order by s.i) into v_merged from (
        select e, i from jsonb_array_elements(v_merged) with ordinality t(e, i) order by e->>'read_at' desc, i limit 4) s;
    end if;
    update relay.asn_user_accounts
      set windows = v_merged, plan = case when v_plan <> '' then v_plan else plan end,
          seen_at = v_now, seen_node = p_node, updated_at = v_now
      where user_id = v_user and vendor = v_vendor and account = v_email;
    -- Gemini 哪台在用（#374）：把這台的那一格換成這次回報的（current 照電腦端；最多留 20 台，新的在前）
    if v_vendor in ('gemini', 'minimax') then
      v_gemini := v_gemini || (v_vendor || chr(10) || v_email);
      update relay.asn_user_accounts
        set nodes = (select coalesce(jsonb_agg(x.e order by x.k), '[]'::jsonb) from (
            select e, k from (
              select (jsonb_build_object('node', p_node, 'current', coalesce(v_row->'current' = 'true'::jsonb, false),
                       'reported_at', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
                     || case when v_row->'login_failed' = 'true'::jsonb then jsonb_build_object('login_failed', true) else '{}'::jsonb end
                     || case when v_row->'login_incomplete' = 'true'::jsonb then jsonb_build_object('login_incomplete', true) else '{}'::jsonb end) e, 0::bigint k
              union all
              select e, k from jsonb_array_elements(nodes) with ordinality t(e, k) where e->>'node' is distinct from p_node
            ) a order by k limit 20) x)
        where user_id = v_user and vendor = v_vendor and account = v_email;
    end if;
    v_count := v_count + 1;
  end loop;
  -- 這次回報沒有的 gemini 帳號：這台已經不用了，拿掉這台的那一格
  update relay.asn_user_accounts u
    set nodes = (select coalesce(jsonb_agg(e order by k), '[]'::jsonb) from jsonb_array_elements(u.nodes) with ordinality t(e, k) where e->>'node' is distinct from p_node)
    where u.user_id = v_user and u.vendor in ('gemini', 'minimax') and not ((u.vendor || chr(10) || u.account) = any(v_gemini))
      and exists (select 1 from jsonb_array_elements(u.nodes) e where e->>'node' = p_node);
  delete from relay.asn_user_accounts d
    using (select vendor, account from relay.asn_user_accounts where user_id = v_user
             order by seen_at desc, updated_at desc, created_at desc offset 100) x
    where d.user_id = v_user and d.vendor = x.vendor and d.account = x.account;
  return jsonb_build_object('ok', true, 'count', v_count, 'skipped', v_skipped);
end;
$function$;

create or replace function public.asn_relay_acct_roster(p_actor text, p_signed_user uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  return jsonb_build_object(
    'now', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object(
          'vendor', u.vendor, 'account', u.account, 'plan', u.plan, 'windows', u.windows,
          'seen_at', to_char(u.seen_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'seen_node', u.seen_node, 'shared', u.share_hash is not null,
          'nodes', case when u.vendor in ('gemini', 'minimax') then coalesce((
            -- Gemini 不在舊表：從這個帳號自己記的那幾台取（#374）
            select jsonb_agg(jsonb_build_object(
                'node', e->>'node', 'current', coalesce(e->'current' = 'true'::jsonb, false), 'reported_at', e->>'reported_at',
                'login_failed', coalesce(e->'login_failed' = 'true'::jsonb, false), 'login_incomplete', coalesce(e->'login_incomplete' = 'true'::jsonb, false)) order by e->>'node')
              from jsonb_array_elements(u.nodes) e
              join relay.nodes n on n.id = e->>'node'
              where n.owner_user = p_signed_user and public.asn_user_owns_node(p_signed_user, n.id)), '[]'::jsonb)
          else coalesce((
            select jsonb_agg(jsonb_build_object(
                'node', a.node, 'current', coalesce((e->>'current')::boolean, false),
                'reported_at', to_char(a.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'login_failed', coalesce(e->'login_failed' = 'true'::jsonb, false), 'login_incomplete', coalesce(e->'login_incomplete' = 'true'::jsonb, false)) order by a.node)
              from relay.asn_accounts a
              join relay.nodes n on n.id = a.node
              cross join lateral jsonb_array_elements(a.accounts) e
              where n.owner_user = p_signed_user and public.asn_user_owns_node(p_signed_user, n.id)
                and e->>'vendor' = u.vendor and e->>'email' = u.account), '[]'::jsonb) end)
        order by u.vendor, u.account)
        from relay.asn_user_accounts u
        where u.user_id = p_signed_user and u.seen_at > now() - interval '30 days'), '[]'::jsonb));
end;
$function$;

-- 查詢：代碼在 relay 算成雜湊才進來。每個來源每小時最多 600 次；查不到的最多 30 次。超過 30 天沒回報的帳號畫面上看不到，這裡也不回。
create or replace function public.asn_relay_quota_read(p_ip_hash text, p_code_hash text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_bucket timestamptz := date_trunc('hour', now());
  v_hits int;
  v_misses int;
  v_new boolean;
  v_u record;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' or p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  insert into relay.asn_quota_read_hits as h (ip_hash, bucket, hits) values (p_ip_hash, v_bucket, 1)
    on conflict (ip_hash, bucket) do update set hits = h.hits + 1
    returning h.hits, h.misses, (h.xmax = 0) into v_hits, v_misses, v_new;
  if v_new then
    delete from relay.asn_quota_read_hits where bucket < v_bucket - interval '1 hour';
  end if;
  if v_hits > 600 or v_misses >= 30 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  select vendor, plan, windows into v_u from relay.asn_user_accounts
    where share_hash = p_code_hash and seen_at > now() - interval '30 days';
  if not found then
    update relay.asn_quota_read_hits set misses = misses + 1 where ip_hash = p_ip_hash and bucket = v_bucket;
    return jsonb_build_object('record', null);
  end if;
  return jsonb_build_object('record', jsonb_build_object('vendor', v_u.vendor, 'plan', v_u.plan, 'windows', v_u.windows));
end;
$function$;

-- 本人開或撤代碼：p_code_hash 有值＝開（已有的舊代碼立刻失效），null＝撤。一定要本人簽章，只動得到自己的帳號列。
create or replace function public.asn_relay_acct_share_set(p_actor text, p_signed_user uuid, p_vendor text, p_account text, p_code_hash text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_code_hash is not null and p_code_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.asn_user_accounts
    set share_hash = p_code_hash, share_created_at = case when p_code_hash is null then null else now() end
    where user_id = p_signed_user and vendor = p_vendor and account = p_account;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.asn_relay_acct_window_judge(text, text, jsonb, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_window_judge(text, text, jsonb, jsonb, timestamptz) to service_role;
revoke all on function public.asn_relay_acct_windows_clean(text, jsonb, text, timestamptz) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_windows_clean(text, jsonb, text, timestamptz) to service_role;
revoke all on function public.asn_relay_acct_roster_report(text, jsonb) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_roster_report(text, jsonb) to service_role;
revoke all on function public.asn_relay_acct_roster(text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_roster(text, uuid) to service_role;
revoke all on function public.asn_relay_quota_read(text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_quota_read(text, text) to service_role;
revoke all on function public.asn_relay_acct_share_set(text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_share_set(text, uuid, text, text, text) to service_role;

commit;
