-- Gemini、MiniMax 同一期剩餘回升改走待確認（#1261）。
--
-- 現況：同一期（重置時間差 10 分鐘內）剩餘回升（same_period_rise）一律拒收，只有 Gemini／MiniMax 記著 100% 才例外。
-- 真實案例：Gemini 每週剩 0% 之後讀到 99%，同一個桶、同一期，結果一直被擋到重置為止。
-- 自從 older_read（20261111200000）擋掉別台送來的舊值，這條規則真正剩下的用途只有「防止數字貼錯帳號」，所以不必硬擋。
--
-- 這支做的事：
--  1. asn_relay_acct_window_decide（20261111200000 版）：除了下列片段逐字相同。vendor 是 gemini／minimax、judge 回 same_period_rise、
--     而且新窗的 read_at 比已存的新時，不直接拒收，改走待確認：同一個新值（重置時間差 10 分鐘內、剩餘與第一次看到的差 ±2% 以內）
--     連續 3 次、第一次到這次至少隔 10 分鐘才收；中間來了不同的值就重新計數；待確認期間已存的值不動，原因代碼仍是 same_period_rise。
--     pending 沿用 window_pending 欄位，多記一個 left_pct（第一次看到的剩餘 %）。缺 read_at 的照舊直接拒收。Claude、Codex 維持現狀。
--  2. 不動 asn_relay_acct_window_judge、asn_relay_acct_roster_report、任何資料表（不新增欄位）。原因代碼不變。
-- 電腦端（Gemini）同一份規則寫在 claude_quota/merge.rs 的 confirm_rise，共用案例 tests/fixtures/quota-merge-cases.json 的 confirm_sequences 兩邊都跑。
-- 權限：維持只給 service_role。部署順序：本 migration → relay（Edge Function，不需改）→ 電腦端。
-- 回復：supabase/sql/rollback/20261112500000_acct_quota_rise_confirm_down.sql（換回上一版本體；window_pending 裡多出的 left_pct 無害）。
begin;

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
  v_left int;
begin
  -- 讀取時間比後台現在晚超過 5 分鐘＝電腦時鐘走快，拒收（否則這筆會一直贏過正常的）
  if jsonb_typeof(p_new->'read_at') = 'string' and (p_new->>'read_at')::timestamptz > p_now + interval '5 minutes' then
    return jsonb_build_object('reason', 'future_read', 'pending', p_pending);
  end if;
  -- 讀取時間比已存的更早＝舊視窗的舊數字，先擋（在 judge 之前，Gemini 滿額例外也要先過這關）
  if p_old is not null and jsonb_typeof(p_old->'read_at') = 'string' and jsonb_typeof(p_new->'read_at') = 'string'
     and (p_new->>'read_at')::timestamptz < (p_old->>'read_at')::timestamptz then
    return jsonb_build_object('reason', 'older_read', 'pending', p_pending);
  end if;
  v_reason := public.asn_relay_acct_window_judge(p_vendor, p_name, p_old, p_new, p_now);
  -- Gemini、MiniMax 同一期剩餘回升（#1261）：新的讀取時間比已存的新才走待確認（缺讀取時間照舊直接拒收）。
  -- 同一個新值（重置時間差 10 分鐘內、剩餘與第一次看到的差 ±2% 以內）連續 3 次、第一次到這次至少隔 10 分鐘才收；
  -- 中間來了不同的值就重新計數。待確認期間已存的值不動。Claude、Codex 維持回升一律拒收。
  if p_vendor in ('gemini', 'minimax') and v_reason = 'same_period_rise'
     and jsonb_typeof(p_old->'read_at') = 'string' and jsonb_typeof(p_new->'read_at') = 'string'
     and (p_new->>'read_at')::timestamptz > (p_old->>'read_at')::timestamptz then
    v_new_r := (p_new->>'resets_at')::timestamptz;
    v_left := round((p_new->>'left_pct')::numeric)::int;
    v_r := v_new_r;
    v_first := p_now;
    if jsonb_typeof(p_pending) = 'object' and jsonb_typeof(p_pending->'resets_at') = 'string'
       and jsonb_typeof(p_pending->'first_at') = 'string' and jsonb_typeof(p_pending->'count') = 'number'
       and jsonb_typeof(p_pending->'left_pct') = 'number' then
      v_p_r := (p_pending->>'resets_at')::timestamptz;
      if abs(extract(epoch from v_new_r - v_p_r)) <= 600 and abs(v_left - (p_pending->>'left_pct')::numeric) <= 2 then
        v_r := v_p_r;
        v_left := round((p_pending->>'left_pct')::numeric)::int;
        v_first := (p_pending->>'first_at')::timestamptz;
        v_count := least(floor((p_pending->>'count')::numeric)::int + 1, 1000);
      end if;
    end if;
    if v_count >= 3 and p_now - v_first >= interval '10 minutes' then
      return jsonb_build_object('reason', null::text, 'pending', null::jsonb);
    end if;
    return jsonb_build_object('reason', 'same_period_rise', 'pending', jsonb_build_object(
      'resets_at', to_char(v_r at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'count', v_count,
      'first_at', to_char(v_first at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'left_pct', v_left));
  end if;
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

revoke all on function public.asn_relay_acct_window_decide(text, text, jsonb, jsonb, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_window_decide(text, text, jsonb, jsonb, jsonb, timestamptz) to service_role;

commit;
