-- 帳號列表第二批：Gemini 額度（#374，asn真 #1515／#1519，0.1.110，後台）。
--
-- 20261029100000_acct_roster.sql、20261029110000_acct_roster_lock_lower.sql 已部署到正式後台，原檔不改；這支：
--  1. relay.asn_user_accounts 的廠牌檢查加 gemini（約束 asn_user_accounts_vendor_check 換成含 gemini 的版本）。
--  2. asn_relay_acct_window_judge：Gemini 規則照 Codex（不看 7 天倍數），另加一條——現記的那窗是 100% 就照收新的
--     （新的也是 100% 時等於只更新重置時間與讀取時間）。原因：agy 對沒用過的桶，每次給的重置時間都是「現在＋整個窗長」，
--     不加這條，滿額遇滿額（隔 10 分鐘以上）、或滿額後開始用，都會被判 later_not_expired，畫面停在 100% 最多 7 天。
--     現記的不是 100%、新來的是 100% 照舊判斷（重置時間較晚＝later_not_expired 不收）。只限 gemini；claude、codex、grok 行為不變。
--     其餘本體與 20261029100000 版逐字相同。共用案例見 tests/fixtures/quota-merge-cases.json（電腦端 merge.rs 同一張 PR 一起改）。
--  3. asn_relay_acct_windows_clean：gemini 的額度窗可收，但只收 five_hour、weekly 兩個窗名（w<分鐘數> 丟掉）；其餘與 20261029100000 版逐字相同。
--  4. asn_relay_acct_roster_report：整份檢查的廠牌加 gemini；其餘與 20261029110000 版逐字相同（gemini 走 windows，不退回舊四欄）。
-- 舊表 relay.asn_accounts 與舊函式 asn_relay_acct_report 不加 gemini（relay 呼叫舊函式前會先拿掉 gemini 那幾筆）。
-- 讀取 asn_relay_acct_roster 不改：gemini 帳號照列；nodes 來自 relay.asn_accounts，所以 gemini 的 nodes 是空陣列。
-- 權限照原本：對 public／anon／authenticated 收回，只給 service_role；security definer、search_path 空照舊。
-- 部署順序：本 migration → relay（Edge Function）→ 電腦端。後台與電腦端的新舊判斷要同一版上（電腦端是 0.1.110）。
--   部署：npx supabase db query --linked -f supabase/migrations/20261029130000_acct_roster_gemini.sql（部署前在群組說）。
-- 回復：supabase/sql/rollback/20261029130000_acct_roster_gemini_down.sql（會刪 gemini 的帳號列，執行前先在群組問）。
begin;

alter table relay.asn_user_accounts drop constraint if exists asn_user_accounts_vendor_check;
alter table relay.asn_user_accounts add constraint asn_user_accounts_vendor_check check (vendor in ('claude', 'codex', 'grok', 'gemini'));

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
  if p_vendor = 'gemini' and p_old is not null and jsonb_typeof(p_old->'left_pct') = 'number' and (p_old->>'left_pct')::numeric = 100 then
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
  if p_vendor not in ('claude', 'codex', 'gemini') or jsonb_typeof(p_windows) is distinct from 'array' then
    return '[]'::jsonb;
  end if;
  for v_w in select e from jsonb_array_elements(p_windows) with ordinality t(e, i) order by i limit 16 loop
    exit when jsonb_array_length(v_out) >= 4;
    continue when jsonb_typeof(v_w) <> 'object' or jsonb_typeof(v_w->'name') is distinct from 'string';
    v_name := v_w->>'name';
    continue when v_name !~ '^(five_hour|weekly|w[0-9]{1,6})$';
    -- Gemini 只收 five_hour、weekly（電腦端只對應 gemini-5h、gemini-weekly 兩桶，#1515）
    continue when p_vendor = 'gemini' and v_name not in ('five_hour', 'weekly');
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
       or v_row->>'vendor' is null or v_row->>'vendor' not in ('claude', 'codex', 'grok', 'gemini')
       or not public.asn_relay_acct_email_ok(v_row->>'email')
       or (v_row ? 'plan' and (jsonb_typeof(v_row->'plan') <> 'string' or char_length(v_row->>'plan') > 30 or (v_row->>'plan') ~ '[[:cntrl:]]')) then
      return jsonb_build_object('error', 'bad_request');
    end if;
  end loop;
  -- 依 (vendor, email) 的順序逐筆鎖，兩台電腦以相反順序回報同兩個帳號時不會互等成死結（#524 審查）
  for v_row in select e from jsonb_array_elements(p_accounts) with ordinality t(e, i) order by e->>'vendor', lower(e->>'email'), i loop
    v_vendor := v_row->>'vendor';
    v_email := v_row->>'email';
    v_plan := btrim(coalesce(v_row->>'plan', ''));
    v_new := case
      when v_vendor = 'grok' then '[]'::jsonb
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
    v_count := v_count + 1;
  end loop;
  delete from relay.asn_user_accounts d
    using (select vendor, account from relay.asn_user_accounts where user_id = v_user
             order by seen_at desc, updated_at desc, created_at desc offset 100) x
    where d.user_id = v_user and d.vendor = x.vendor and d.account = x.account;
  return jsonb_build_object('ok', true, 'count', v_count, 'skipped', v_skipped);
end;
$function$;

revoke all on function public.asn_relay_acct_window_judge(text, text, jsonb, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.asn_relay_acct_windows_clean(text, jsonb, text, timestamptz) from public, anon, authenticated;
revoke all on function public.asn_relay_acct_roster_report(text, jsonb) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_window_judge(text, text, jsonb, jsonb, timestamptz) to service_role;
grant execute on function public.asn_relay_acct_windows_clean(text, jsonb, text, timestamptz) to service_role;
grant execute on function public.asn_relay_acct_roster_report(text, jsonb) to service_role;

commit;
