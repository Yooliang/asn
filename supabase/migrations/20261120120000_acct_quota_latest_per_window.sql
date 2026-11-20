-- 額度後台只取每窗最新讀數（#1883）：Claude 額度改成每台直接向 Claude 查、只回報自己目前登入的帳號，後台不再靠規則判斷「這筆數字該不該收」。
--
-- 這支做的事：
--  1. asn_relay_acct_roster_report：同使用者、同廠牌、同帳號，每個窗各取讀取時間（read_at）最新的那筆；
--     進來的比存著的舊就不蓋（skipped 回 older_read），同一秒以進來的為準；不看重置時間、不看是哪一台送的。
--     不再拿掉「這次沒帶、重置時間已過」的窗（顯示端自己處理過期）。每帳號最多留 4 窗、每人最多 100 個帳號列等上限照舊。
--     舊版用戶端的舊欄位（five_hour_pct、weekly_pct、reset_at、at）照收（legacy_windows 當場轉成兩窗存起來，走同一條路），所以蓋不掉時間較新的讀數；
--     舊版若同時帶 windows 與四欄，以 windows 為準。這段四欄轉換只保留這一版，**下一版拿掉**（legacy_windows 與列裡四欄的處理一併移除）。
--     新版 Claude 用戶端（列裡有 windows、沒有舊四欄鍵、windows 不是空的）每次回報整份取代該帳號的窗：這次沒帶的窗拿掉（方案拿掉 5 小時限制後畫面不再殘留 five_hour）；
--     舊版轉換來的讀數不套用這條，只更新有帶的窗；其他廠牌（Gemini、Codex、Grok、MiniMax）也不套用，只更新有帶的窗。
--     舊四欄轉來的讀取時間，比後台現在還晚的同樣記成現在。
--  2. asn_relay_acct_windows_clean：不再丟「重置時間不在現在 −1 天～+8 天」的窗；讀取時間比後台現在還晚的改記成現在（不丟）。其餘逐字照舊。
--  3. 不再用到的 asn_relay_acct_window_decide、asn_relay_acct_window_judge 在這裡 drop。
--  4. 簽名、回傳形狀、權限不變（另外 drop 了 asn_relay_acct_window_decide、asn_relay_acct_window_judge 兩個函式，回復檔會還原它們）；不動資料表（window_pending 欄位保留，不再寫入）。
-- 部署順序：本 migration → relay（Edge Function，不需改）→ 電腦端。
-- 回復：supabase/sql/rollback/20261120120000_acct_quota_latest_per_window_down.sql（換回 judge、decide、windows_clean、roster_report 的上一版本體）。
begin;

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
    -- 只丟掉沒有讀取時間的；讀取時間比後台現在還晚（電腦時鐘走快）的，改記成現在，不讓它一直贏過之後正常的讀數
    continue when v_read is null;
    v_read := to_char(least(v_read::timestamptz, p_now) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
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
      -- 舊四欄轉來的讀取時間也照 windows 的規則：比後台現在還晚的記成現在（不丟），免得之後正常的讀數被它擋掉
      select coalesce(jsonb_agg(jsonb_set(e, '{read_at}', to_jsonb(to_char(least((e->>'read_at')::timestamptz, v_now) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) order by i), '[]'::jsonb)
        into v_new from jsonb_array_elements(v_new) with ordinality t(e, i);
    end if;
    insert into relay.asn_user_accounts (user_id, vendor, account, plan, seen_node)
      values (v_user, v_vendor, v_email, v_plan, p_node)
      on conflict (user_id, vendor, account) do nothing;
    select windows into v_merged from relay.asn_user_accounts
      where user_id = v_user and vendor = v_vendor and account = v_email for update;
    -- 每個窗各取讀取時間最新的那筆：進來的比存著的舊就不蓋（回原因代碼 older_read），同一秒以進來的為準。
    -- 不看重置時間、不看是哪一台送的；舊版用戶端的舊欄位（legacy_windows）走同一條路，所以蓋不掉較新的讀數。
    for v_w in select e from jsonb_array_elements(v_new) with ordinality t(e, i) order by i loop
      select e into v_o from jsonb_array_elements(v_merged) e where e->>'name' = v_w->>'name' limit 1;
      if v_o is null then
        v_merged := v_merged || jsonb_build_array(v_w);
      elsif (v_w->>'read_at') < coalesce(public.asn_relay_acct_iso(v_o->'read_at'), '') then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('vendor', v_vendor, 'window', v_w->>'name', 'reason', 'older_read'));
      else
        select jsonb_agg(case when e->>'name' = v_w->>'name' then v_w else e end order by i) into v_merged
          from jsonb_array_elements(v_merged) with ordinality t(e, i);
      end if;
    end loop;
    -- 新版用戶端（列裡有 windows、沒有任何舊四欄鍵）每次回報就是這個帳號現在有的窗：這次沒帶的窗從後台拿掉
    -- （例如方案拿掉 5 小時限制後不再有 five_hour）。上面「較舊不蓋較新」照舊：這次有帶的窗，被擋時維持存著的。
    -- windows 是空的（這次讀不到）不算「都沒有了」，不動。舊版用戶端（列裡有舊四欄）不套用，只更新有帶的窗。
    if v_vendor = 'claude' and v_row ? 'windows' and v_new <> '[]'::jsonb
       and not (v_row ?| array['five_hour_pct', 'weekly_pct', 'reset_at', 'at', 'five_reset_at', 'week_reset_at']) then
      select coalesce(jsonb_agg(e order by i), '[]'::jsonb) into v_merged
        from jsonb_array_elements(v_merged) with ordinality t(e, i)
        where exists (select 1 from jsonb_array_elements(v_new) n where n->>'name' = e->>'name');
    end if;
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

drop function if exists public.asn_relay_acct_window_decide(text, text, jsonb, jsonb, jsonb, timestamptz);
drop function if exists public.asn_relay_acct_window_judge(text, text, jsonb, jsonb, timestamptz);

revoke all on function public.asn_relay_acct_windows_clean(text, jsonb, text, timestamptz) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_windows_clean(text, jsonb, text, timestamptz) to service_role;
revoke all on function public.asn_relay_acct_roster_report(text, jsonb) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_roster_report(text, jsonb) to service_role;

commit;
