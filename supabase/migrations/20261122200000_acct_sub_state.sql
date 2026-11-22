-- 帳號回報多收一個選填欄位 sub_state（訂閱狀態，#1646 拆項 D，後台）：'active'（訂閱中）、'lapsed'（訂閱已失效）、'unknown'（電腦端判不出來）三值字串。
-- 比照 20261031100000_acct_login_flags.sql 的路徑：帳號回報進資料庫是逐欄重組的，不認得的欄位會被丟掉，所以要改函式。
--
-- 三支函式各改一處，其餘本體與線上現行版逐字相同（回報＝20261115100000_acct_usable_at.sql 版；名單寫入＝20261120120000_acct_quota_latest_per_window.sql 版；名單讀出＝20261110100000_acct_quota_share.sql 版）：
--  1. asn_relay_acct_report（寫 relay.asn_accounts，每台電腦一列）：選填；有帶就要是上述三個字串之一，否則整份退回 bad_request（跟其他欄位同一條規則）；只存 claude 的帳號。
--     「沒帶」不動：這支每次整列重寫，所以沒帶時改沿用同一台、同一帳號（email 不分大小寫）上次存的值，沒有就不存。
--     這點與 login_failed 不同：login_failed 只存 true、沒帶＝清掉（恢復後旗標自然消失）；訂閱狀態則是明說 'active' 才清、沒帶不清。
--  2. asn_relay_acct_roster_report（寫 relay.asn_user_accounts）：只檢查型別（讓兩條寫入的拒收規則一致），不存。
--     這張表是「每個帳號一列、跨電腦合併」，沒有每台電腦的欄位；claude 的每台狀態讀自上一條那張表。gemini／minimax 不是訂閱制偵測的對象，不存。
--  3. asn_relay_acct_roster（讀出）：accounts[].nodes[] 每格多回 sub_state（一律回字串，沒有資料＝'unknown'，不會被誤判成失效）。
-- asn_relay_acct_quota 不用改：訂閱狀態不是額度，且該函式在沒有額度百分比時整個回空物件，放進去會被連帶丟掉；與 login_failed 當年相同，在回報函式直接處理。
-- 為什麼用三值字串、不用布林（像 login_failed）：電腦端本來就判出三種；布林只存 true 時「沒帶」與「明說沒失效」分不出來，
--   沒帶就沒辦法安全地沿用舊值；三值字串明說 'active' 才清、'unknown' 不會蓋成「沒問題」也不會觸發警示。
-- 權限：三支都 create or replace（security definer／search_path 空照舊），最後照現況 revoke public／anon／authenticated、只 grant service_role；沒有放寬任何權限。
-- 沒有改資料表：不加欄位、不搬資料，只換函式本體（值存在既有的 jsonb 裡）。
-- 相容：
--   - 舊版電腦不帶這欄：不改變已存的值、讀出是 'unknown'（沒存過）或原值；
--   - 新版電腦打到還沒套這支的後台：Edge Function 若已更新會把 sub_state 交給舊函式，舊函式逐欄重組時丟掉，不會壞；
--   - Edge Function 還沒更新：它的清單整理本來就會丟掉不認得的欄位。
-- 部署順序：本 migration → relay（Edge Function）→ 電腦端。任何一步提早上都不會壞。
--   部署：npx supabase db query --linked -f supabase/migrations/20261122200000_acct_sub_state.sql（部署前在群組說）。
-- 回復：supabase/sql/rollback/20261122200000_acct_sub_state_down.sql（換回現行本體；已存的 sub_state 留在 jsonb 裡，舊函式不讀，無害）。
begin;

create or replace FUNCTION public.asn_relay_acct_report(p_node text, p_accounts jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_row jsonb;
  v_out jsonb := '[]'::jsonb;
  v_old jsonb;
  v_sub text;
begin
  if p_accounts is null or jsonb_typeof(p_accounts) <> 'array' or jsonb_array_length(p_accounts) > 20 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active') then
    return jsonb_build_object('error', 'not_found');
  end if;
  -- 這台上一次回報存的清單：訂閱狀態「沒帶」時沿用它（見上方說明）
  select accounts into v_old from relay.asn_accounts where node = p_node for update;
  v_old := coalesce(v_old, '[]'::jsonb);
  for v_row in select * from jsonb_array_elements(p_accounts) loop
    if jsonb_typeof(v_row) <> 'object'
       or v_row->>'vendor' is null or v_row->>'vendor' not in ('claude', 'codex', 'grok')
       or not public.asn_relay_acct_email_ok(v_row->>'email')
       or (v_row ? 'plan' and (jsonb_typeof(v_row->'plan') <> 'string' or char_length(v_row->>'plan') > 30 or (v_row->>'plan') ~ '[[:cntrl:]]'))
       or (v_row ? 'current' and jsonb_typeof(v_row->'current') <> 'boolean')
       or (v_row ? 'login_failed' and jsonb_typeof(v_row->'login_failed') <> 'boolean')
       or (v_row ? 'login_incomplete' and jsonb_typeof(v_row->'login_incomplete') <> 'boolean')
       or (v_row ? 'usable_at' and (jsonb_typeof(v_row->'usable_at') <> 'string' or (v_row->>'usable_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'))
       or (v_row ? 'sub_state' and (jsonb_typeof(v_row->'sub_state') <> 'string' or (v_row->>'sub_state') not in ('active', 'lapsed', 'unknown'))) then
      return jsonb_build_object('error', 'bad_request');
    end if;
    -- 訂閱狀態（只有 claude）：有帶就用這次的；沒帶（舊版用戶端）就沿用這台上次存的，沒有就不存
    v_sub := null;
    if v_row->>'vendor' = 'claude' then
      v_sub := case when v_row ? 'sub_state' then v_row->>'sub_state' else (
        select e->>'sub_state' from jsonb_array_elements(v_old) e
          where e->>'vendor' = 'claude' and lower(e->>'email') = lower(v_row->>'email') limit 1) end;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'vendor', v_row->>'vendor', 'email', v_row->>'email', 'plan', coalesce(v_row->>'plan', ''), 'current', coalesce((v_row->>'current')::boolean, false))
      || case when v_row->'login_failed' = 'true'::jsonb then jsonb_build_object('login_failed', true) else '{}'::jsonb end
      || case when v_row->'login_incomplete' = 'true'::jsonb then jsonb_build_object('login_incomplete', true) else '{}'::jsonb end
      || case when v_row->>'vendor' = 'claude' and v_row ? 'usable_at' then jsonb_build_object('usable_at', v_row->>'usable_at') else '{}'::jsonb end
      || case when v_sub is not null then jsonb_build_object('sub_state', v_sub) else '{}'::jsonb end
      || case when v_row->>'vendor' = 'claude' then public.asn_relay_acct_quota(v_row) else '{}'::jsonb end);
  end loop;
  insert into relay.asn_accounts (node, accounts, updated_at) values (p_node, v_out, now())
    on conflict (node) do update set accounts = excluded.accounts, updated_at = excluded.updated_at;
  return jsonb_build_object('ok', true, 'count', jsonb_array_length(v_out));
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
       or (v_row ? 'login_incomplete' and jsonb_typeof(v_row->'login_incomplete') <> 'boolean')
       or (v_row ? 'sub_state' and (jsonb_typeof(v_row->'sub_state') <> 'string' or (v_row->>'sub_state') not in ('active', 'lapsed', 'unknown'))) then
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
                'login_failed', coalesce(e->'login_failed' = 'true'::jsonb, false), 'login_incomplete', coalesce(e->'login_incomplete' = 'true'::jsonb, false),
                'sub_state', coalesce(e->>'sub_state', 'unknown')) order by e->>'node')
              from jsonb_array_elements(u.nodes) e
              join relay.nodes n on n.id = e->>'node'
              where n.owner_user = p_signed_user and public.asn_user_owns_node(p_signed_user, n.id)), '[]'::jsonb)
          else coalesce((
            select jsonb_agg(jsonb_build_object(
                'node', a.node, 'current', coalesce((e->>'current')::boolean, false),
                'reported_at', to_char(a.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'login_failed', coalesce(e->'login_failed' = 'true'::jsonb, false), 'login_incomplete', coalesce(e->'login_incomplete' = 'true'::jsonb, false),
                'sub_state', coalesce(e->>'sub_state', 'unknown')) order by a.node)
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

revoke all on function public.asn_relay_acct_report(text, jsonb) from public, anon, authenticated;
revoke all on function public.asn_relay_acct_roster_report(text, jsonb) from public, anon, authenticated;
revoke all on function public.asn_relay_acct_roster(text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_report(text, jsonb) to service_role;
grant execute on function public.asn_relay_acct_roster_report(text, jsonb) to service_role;
grant execute on function public.asn_relay_acct_roster(text, uuid) to service_role;

commit;
