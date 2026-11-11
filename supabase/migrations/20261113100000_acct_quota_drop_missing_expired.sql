-- 讀數沒有某一窗、而存著的那一窗已過重置時間：後台把那一窗拿掉（#1321）。
--
-- 背景：Claude 的最大訂閱方案拿掉了 5 小時限制，rate_limits 裡不再有 five_hour。後台 cwen 的 five_hour 停在 10-30，weekly 則一直在更新；
-- 因為這次回報沒有 five_hour 時，roster_report 只合併「有帶的窗」，沒帶的窗留著，那個重置時間早就過了的舊數字就一直掛著（畫面寫「可能已恢復」）。
--
-- 這支做的事：
--  1. asn_relay_acct_roster_report：除了下列片段與 20261111200000 版逐字相同——合併完這次回報的窗之後，如果這次回報有帶 windows，
--     而存著的某一窗的 name 不在這次回報（清理後）的窗裡、且它的 resets_at 已經過了，就從 windows 拿掉。
--     還沒過重置時間的（只是這次剛好沒帶）留著；resets_at 是空的（無從判斷）留著；沒帶 windows 的舊用戶端完全不動。
--     不管另一窗這次有沒有被 decide 擋掉都照做。
--  2. 不動 decide、judge、windows_clean、任何資料表（不新增欄位）。
-- 電腦端同一條規則寫在 claude_quota/merge.rs 的 without_missing_expired（Claude、Gemini 都用）。
-- 權限：維持只給 service_role；security definer、search_path 空。
-- 部署順序：本 migration → relay（Edge Function，不需改）→ 電腦端。
-- 回復：supabase/sql/rollback/20261113100000_acct_quota_drop_missing_expired_down.sql（換回上一版本體；已被拿掉的窗不會回來，下次回報會重新帶）。
begin;

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
    -- 這次回報帶了 windows、但某個 name 完全沒有，而存著的那一窗 resets_at 已經過了（例如方案拿掉 5 小時限制，rate_limits 不再有 five_hour）：
    -- 那一窗已經沒有了，從 windows 拿掉，不要一直掛著過期的舊數字（#1321）。還沒過重置時間的（只是這次剛好沒帶）、沒有 resets_at 的（無從判斷）留著；
    -- 沒帶 windows 的舊用戶端不動。
    -- resets_at 不是合法時間（舊資料或被改壞）時不能丟錯，整支 roster_report 會停；Postgres 也不保證 and 會短路，所以轉型放進有例外處理的區塊，轉不了就當無從判斷、留著。
    if v_row ? 'windows' and jsonb_typeof(v_row->'windows') = 'array' then
      declare
        v_keep jsonb := '[]'::jsonb;
        v_gone boolean;
      begin
        for v_w in select e from jsonb_array_elements(v_merged) with ordinality t(e, i) order by i loop
          v_gone := false;
          if not exists (select 1 from jsonb_array_elements(v_new) n where n->>'name' = v_w->>'name')
             and jsonb_typeof(v_w->'resets_at') = 'string' then
            begin
              v_gone := (v_w->>'resets_at')::timestamptz <= v_now;
            exception when others then
              v_gone := false;
            end;
          end if;
          if not v_gone then
            v_keep := v_keep || jsonb_build_array(v_w);
          end if;
        end loop;
        v_merged := v_keep;
      end;
    end if;
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

revoke all on function public.asn_relay_acct_roster_report(text, jsonb) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_roster_report(text, jsonb) to service_role;

commit;
