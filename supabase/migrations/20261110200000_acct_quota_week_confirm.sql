-- 每週額度倍數檢查的放寬（#1184，修「換帳號／閒置後新一期不是 7 天倍數，一直被當成別的帳號拒收」）。
--
-- 這支做的事：
--  1. relay.asn_user_accounts 多一欄 window_pending（預設 {}）：每個窗名一筆「待確認的重置時間」{ resets_at, count, first_at }。
--  2. 新函式 asn_relay_acct_window_decide：包在 asn_relay_acct_window_judge 外面（judge 本體不動）。只有 judge 回 not_week_multiple
--     （Claude 每週窗、現記的重置時間已過期、新的更晚卻不是 7 天倍數）時才動：同一個新重置時間（差 10 分鐘內）連續 3 次、
--     第一次到這次至少隔 10 分鐘，才收下（待確認清掉）；否則不收、記下待確認；中間來了不同的重置時間就重新計數。
--     現記的還沒過期（later_not_expired）、同期回升、較早、範圍外等其他結果一律照舊。條件與電腦端 merge.rs 的 confirm_week 完全一樣，
--     共用案例 tests/fixtures/quota-merge-cases.json 的 confirm_sequences 兩邊都跑。
--  3. asn_relay_acct_roster_report：除了下列片段，與 20261110100000 版逐字相同——多讀寫 window_pending、判斷改呼叫 decide。
--
-- 舊用戶端不受影響：回報格式不變；對外回傳（roster、查詢）不含 window_pending；skipped 的原因代碼不變。
-- 權限：新函式對 public／anon／authenticated 收回，只給 service_role；security definer 的函式 search_path 空。
-- 部署順序：本 migration → relay（Edge Function，這次不需改）→ 電腦端。先上 migration 時舊電腦端照常運作。
-- 回復：supabase/sql/rollback/20261110200000_acct_quota_week_confirm_down.sql（只會丟掉待確認的暫存，不動任何額度）。
begin;

alter table relay.asn_user_accounts add column if not exists window_pending jsonb not null default '{}'::jsonb;

create or replace function public.asn_relay_acct_window_decide(p_vendor text, p_name text, p_old jsonb, p_new jsonb, p_pending jsonb, p_now timestamptz)
 returns jsonb
 language plpgsql
 stable
 set search_path to ''
as $function$
declare
  v_reason text;
  v_new_r timestamptz;
  v_p_r timestamptz;
  v_r timestamptz;
  v_first timestamptz;
  v_count int := 1;
begin
  v_reason := public.asn_relay_acct_window_judge(p_vendor, p_name, p_old, p_new, p_now);
  -- 只有 Claude 每週倍數不過（not_week_multiple）才走待確認；其他結果照舊，待確認原樣帶回
  if v_reason is distinct from 'not_week_multiple' then
    return jsonb_build_object('reason', v_reason, 'pending', case when v_reason is null then null::jsonb else p_pending end);
  end if;
  v_new_r := (p_new->>'resets_at')::timestamptz;
  v_r := v_new_r;
  v_first := p_now;
  if jsonb_typeof(p_pending) = 'object' and jsonb_typeof(p_pending->'resets_at') = 'string'
     and jsonb_typeof(p_pending->'first_at') = 'string' and jsonb_typeof(p_pending->'count') = 'number' then
    v_p_r := (p_pending->>'resets_at')::timestamptz;
    if abs(extract(epoch from v_new_r - v_p_r)) <= 600 then
      v_r := v_p_r;
      v_first := (p_pending->>'first_at')::timestamptz;
      v_count := least(floor((p_pending->>'count')::numeric)::int + 1, 1000);
    end if;
  end if;
  if v_count >= 3 and p_now - v_first >= interval '10 minutes' then
    return jsonb_build_object('reason', null::text, 'pending', null::jsonb);
  end if;
  return jsonb_build_object('reason', 'not_week_multiple', 'pending', jsonb_build_object(
    'resets_at', to_char(v_r at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'count', v_count,
    'first_at', to_char(v_first at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
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
  v_pending jsonb;
  v_dec jsonb;
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
    select windows, window_pending into v_merged, v_pending from relay.asn_user_accounts
      where user_id = v_user and vendor = v_vendor and account = v_email for update;
    for v_w in select e from jsonb_array_elements(v_new) with ordinality t(e, i) order by i loop
      select e into v_o from jsonb_array_elements(v_merged) e where e->>'name' = v_w->>'name' limit 1;
      -- 每週倍數不過時先記待確認，同一個新重置時間連續 3 次、隔滿 10 分鐘才收（#1184）；其餘判斷照舊
      v_dec := public.asn_relay_acct_window_decide(v_vendor, v_w->>'name', v_o, v_w, v_pending->(v_w->>'name'), v_now);
      v_reason := v_dec->>'reason';
      v_pending := case when jsonb_typeof(v_dec->'pending') = 'object'
        then v_pending || jsonb_build_object(v_w->>'name', v_dec->'pending') else v_pending - (v_w->>'name') end;
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
      set windows = v_merged, window_pending = v_pending, plan = case when v_plan <> '' then v_plan else plan end,
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

revoke all on function public.asn_relay_acct_window_decide(text, text, jsonb, jsonb, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_window_decide(text, text, jsonb, jsonb, jsonb, timestamptz) to service_role;
revoke all on function public.asn_relay_acct_roster_report(text, jsonb) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_roster_report(text, jsonb) to service_role;

commit;
