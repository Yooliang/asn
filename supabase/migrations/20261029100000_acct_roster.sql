-- 帳號列表第一批（#374，0.1.107，後台）：以 ASN 帳號為單位，彙整各廠牌帳號與額度窗。
--
-- 新表 relay.asn_user_accounts：一筆＝「ASN 帳號（user_id）× 廠牌（vendor）× 該廠牌帳號（account，即 email）」。
--   plan 方案；windows 額度窗陣列（最多 4 個），每窗 {name, left_pct, resets_at, read_at, read_node}：
--     name：five_hour（5 小時）、weekly（每週）、或 w<分鐘數>（Codex 其他長度；w300／w10080 會轉成 five_hour／weekly）
--     left_pct：剩餘百分比 0～100 整數；resets_at：重置時間（可空）；read_at：那台電腦讀到數字的時間；read_node：哪台讀的
--   seen_at／seen_node：最後一次被哪台回報、何時；每人最多 100 筆，超過刪 seen_at 最舊的。
--   權限：開 RLS、不寫 policy、對 public／anon／authenticated 全部收回；讀寫只經下面的 security definer 函式（只給 service_role）。
--   跟 relay.asn_accounts 同一套。沒有外鍵指向 relay.nodes（seen_node、read_node 只是記錄，節點刪掉不擋）。
--
-- 寫入 asn_relay_acct_roster_report(p_node, p_accounts)：relay 的 acct_report 先照舊呼叫 asn_relay_acct_report，再呼叫這支。
--   用 relay.nodes.owner_user 找人，且 asn_user_owns_node 成立（節點與租戶都是這個人的）才寫；沒認領的電腦不寫。
--   每個帳號 select … for update 鎖住同一筆，逐窗判斷（規則見 asn_relay_acct_window_judge）、逐窗合併，一次交易完成。
--   舊版只送四欄（five_hour_pct、weekly_pct、reset_at、at）時，照電腦端 merge.rs 的 stored_resets 反推成兩窗。
--   grok 一律不收額度（只記帳號）。回傳 {ok, count, skipped:[{vendor, window, reason}]}，不含 email。
-- 讀取 asn_relay_acct_roster(p_actor, p_signed_user)：要本人簽章且 asn_user_owns_node(p_signed_user, p_actor)，只回自己的；
--   列 seen_at 在 30 天內的帳號（所有電腦都不再回報的保留 30 天，畫面用 seen_at／read_at 標「N 天前讀的」）；
--   附 nodes：本人名下在用設備最近一次回報（relay.asn_accounts）裡有這個帳號的那幾台，current＝那台正在用。
--   windows 是空陣列＝沒有額度資料（例如沒開 Codex），前端據此標示。
--
-- 舊的 asn_relay_acct_report、asn_relay_acct_quota、relay.asn_accounts 一字不改。
-- 部署順序：本 migration → relay（Edge Function）→ 用戶端。任何一步提早上都不會壞：
--   relay 先上＝新函式呼叫失敗只記 log、acct_report 照回 ok；用戶端先上＝acct_roster 打舊 relay 回 404，畫面照舊。
-- 回復：supabase/sql/rollback/20261029100000_acct_roster_down.sql（drop 函式與表；表裡是回報算出來的資料，drop 仍算刪資料，執行前先問）。
begin;

create table relay.asn_user_accounts (
  user_id uuid not null,
  vendor text not null,
  account text not null,
  plan text not null default '',
  windows jsonb not null default '[]'::jsonb,
  seen_at timestamptz not null default now(),
  seen_node text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint asn_user_accounts_pkey primary key (user_id, vendor, account),
  constraint asn_user_accounts_vendor_check check (vendor in ('claude', 'codex', 'grok')),
  constraint asn_user_accounts_account_check check (char_length(account) between 3 and 120 and account = lower(account)),
  constraint asn_user_accounts_plan_check check (char_length(plan) <= 30),
  constraint asn_user_accounts_windows_check check (jsonb_typeof(windows) = 'array' and jsonb_array_length(windows) <= 4)
);
create index asn_user_accounts_user_seen_idx on relay.asn_user_accounts (user_id, seen_at desc);
alter table relay.asn_user_accounts enable row level security;
revoke all on relay.asn_user_accounts from public, anon, authenticated;

-- 一個額度窗收不收（#1342／#1372）：回 null＝收，否則回不收的原因代碼。共用案例見 tests/fixtures/quota-merge-cases.json。
--   沒有 old、或任一邊沒有重置時間＝收；現在晚於 old 重置時間超過 7 天＝收；
--   新舊重置時間相差 10 分鐘內＝同一期，剩餘只能下降（回升＝same_period_rise）；新的較早＝earlier；
--   新的較晚但 old 還沒過＝later_not_expired；Claude 的每週窗另要新舊差接近 7 天倍數（誤差 10 分鐘），否則 not_week_multiple。
--   Codex 每週窗與所有 5 小時窗不看倍數。
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
  if p_old is null or jsonb_typeof(p_old->'resets_at') is distinct from 'string' or jsonb_typeof(p_new->'resets_at') is distinct from 'string' then
    return null;
  end if;
  v_old_r := (p_old->>'resets_at')::timestamptz;
  v_new_r := (p_new->>'resets_at')::timestamptz;
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

-- 時間字串 → UTC 秒級 ISO；不合格回 null
create or replace function public.asn_relay_acct_iso(p_v jsonb)
 returns text
 language plpgsql
 stable
 set search_path to ''
as $function$
begin
  if jsonb_typeof(p_v) <> 'string' or char_length(p_v #>> '{}') > 40 then
    return null;
  end if;
  return to_char((p_v #>> '{}')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
exception when others then
  return null;
end;
$function$;

-- 新版回報的 windows 整理：只收 claude、codex；壞掉的單窗丟掉（不退回整份）；同名只留第一個；最多 4 個。
--   left_pct 0～100 取整；read_at 必填、不得晚於現在 10 分鐘以上；resets_at 可空，給了卻壞掉就丟這一窗。
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
  if p_vendor not in ('claude', 'codex') or jsonb_typeof(p_windows) is distinct from 'array' then
    return '[]'::jsonb;
  end if;
  for v_w in select e from jsonb_array_elements(p_windows) with ordinality t(e, i) order by i limit 16 loop
    exit when jsonb_array_length(v_out) >= 4;
    continue when jsonb_typeof(v_w) <> 'object' or jsonb_typeof(v_w->'name') is distinct from 'string';
    v_name := v_w->>'name';
    continue when v_name !~ '^(five_hour|weekly|w[0-9]{1,6})$';
    v_name := case v_name when 'w300' then 'five_hour' when 'w10080' then 'weekly' else v_name end;
    continue when jsonb_typeof(v_w->'left_pct') is distinct from 'number';
    continue when (v_w->>'left_pct')::numeric not between 0 and 100;
    v_read := public.asn_relay_acct_iso(v_w->'read_at');
    continue when v_read is null or v_read::timestamptz > p_now + interval '10 minutes';
    v_reset := null;
    if v_w ? 'resets_at' and jsonb_typeof(v_w->'resets_at') <> 'null' then
      v_reset := public.asn_relay_acct_iso(v_w->'resets_at');
      continue when v_reset is null;
    end if;
    continue when exists (select 1 from jsonb_array_elements(v_out) o where o->>'name' = v_name);
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'name', v_name, 'left_pct', round((v_w->>'left_pct')::numeric)::int, 'resets_at', v_reset, 'read_at', v_read, 'read_node', p_node));
  end loop;
  return v_out;
end;
$function$;

-- 舊版只送四欄（five_hour_pct、weekly_pct、reset_at、at）→ 兩窗。欄位先經舊的 asn_relay_acct_quota 整理（同一套檢查）。
-- 那一個 reset_at 屬於哪一窗，照電腦端 merge.rs 的 stored_resets：
--   兩窗都 0（都用完，存的是較晚那個，分不出）→ 都沒有重置時間；每週 0 → 屬每週；有 5 小時 → 屬 5 小時；只有每週 → 屬每週。
create or replace function public.asn_relay_acct_legacy_windows(p_row jsonb, p_node text)
 returns jsonb
 language plpgsql
 stable
 set search_path to ''
as $function$
declare
  v_q jsonb := public.asn_relay_acct_quota(p_row);
  v_five int := (v_q->>'five_hour_pct')::int;
  v_week int := (v_q->>'weekly_pct')::int;
  v_reset text := v_q->>'reset_at';
  v_five_r text;
  v_week_r text;
  v_out jsonb := '[]'::jsonb;
begin
  if v_q = '{}'::jsonb then
    return v_out;
  end if;
  if v_five = 0 and v_week = 0 then
    null;
  elsif v_week = 0 then
    v_week_r := v_reset;
  elsif v_five is not null then
    v_five_r := v_reset;
  elsif v_week is not null then
    v_week_r := v_reset;
  end if;
  if v_five is not null then
    v_out := v_out || jsonb_build_array(jsonb_build_object('name', 'five_hour', 'left_pct', v_five, 'resets_at', v_five_r, 'read_at', v_q->>'at', 'read_node', p_node));
  end if;
  if v_week is not null then
    v_out := v_out || jsonb_build_array(jsonb_build_object('name', 'weekly', 'left_pct', v_week, 'resets_at', v_week_r, 'read_at', v_q->>'at', 'read_node', p_node));
  end if;
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
       or v_row->>'vendor' is null or v_row->>'vendor' not in ('claude', 'codex', 'grok')
       or not public.asn_relay_acct_email_ok(v_row->>'email')
       or (v_row ? 'plan' and (jsonb_typeof(v_row->'plan') <> 'string' or char_length(v_row->>'plan') > 30 or (v_row->>'plan') ~ '[[:cntrl:]]')) then
      return jsonb_build_object('error', 'bad_request');
    end if;
  end loop;
  for v_row in select e from jsonb_array_elements(p_accounts) with ordinality t(e, i) order by i loop
    v_vendor := v_row->>'vendor';
    v_email := v_row->>'email';
    v_plan := btrim(coalesce(v_row->>'plan', ''));
    v_new := case
      when v_vendor = 'grok' then '[]'::jsonb
      when v_row ? 'windows' then public.asn_relay_acct_windows_clean(v_vendor, v_row->'windows', p_node, v_now)
      when v_vendor = 'claude' then public.asn_relay_acct_legacy_windows(v_row, p_node)
      else '[]'::jsonb end;
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
    v_count := v_count + 1;
  end loop;
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
          'seen_at', to_char(u.seen_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'seen_node', u.seen_node,
          'nodes', coalesce((
            select jsonb_agg(jsonb_build_object(
                'node', a.node, 'current', coalesce((e->>'current')::boolean, false),
                'reported_at', to_char(a.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) order by a.node)
              from relay.asn_accounts a
              join relay.nodes n on n.id = a.node
              cross join lateral jsonb_array_elements(a.accounts) e
              where n.owner_user = p_signed_user and public.asn_user_owns_node(p_signed_user, n.id)
                and e->>'vendor' = u.vendor and e->>'email' = u.account), '[]'::jsonb))
        order by u.vendor, u.account)
        from relay.asn_user_accounts u
        where u.user_id = p_signed_user and u.seen_at > now() - interval '30 days'), '[]'::jsonb));
end;
$function$;

revoke all on function public.asn_relay_acct_window_judge(text, text, jsonb, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.asn_relay_acct_iso(jsonb) from public, anon, authenticated;
revoke all on function public.asn_relay_acct_windows_clean(text, jsonb, text, timestamptz) from public, anon, authenticated;
revoke all on function public.asn_relay_acct_legacy_windows(jsonb, text) from public, anon, authenticated;
revoke all on function public.asn_relay_acct_roster_report(text, jsonb) from public, anon, authenticated;
revoke all on function public.asn_relay_acct_roster(text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_window_judge(text, text, jsonb, jsonb, timestamptz) to service_role;
grant execute on function public.asn_relay_acct_iso(jsonb) to service_role;
grant execute on function public.asn_relay_acct_windows_clean(text, jsonb, text, timestamptz) to service_role;
grant execute on function public.asn_relay_acct_legacy_windows(jsonb, text) to service_role;
grant execute on function public.asn_relay_acct_roster_report(text, jsonb) to service_role;
grant execute on function public.asn_relay_acct_roster(text, uuid) to service_role;

commit;
