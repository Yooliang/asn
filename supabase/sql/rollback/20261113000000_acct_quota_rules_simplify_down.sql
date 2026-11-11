-- 退回 20261113000000_acct_quota_rules_simplify.sql：judge、decide、windows_clean 換回上一版本體（簡化之前的規則）。
begin;

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

revoke all on function public.asn_relay_acct_window_judge(text, text, jsonb, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_window_judge(text, text, jsonb, jsonb, timestamptz) to service_role;
revoke all on function public.asn_relay_acct_window_decide(text, text, jsonb, jsonb, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_window_decide(text, text, jsonb, jsonb, jsonb, timestamptz) to service_role;
revoke all on function public.asn_relay_acct_windows_clean(text, jsonb, text, timestamptz) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_windows_clean(text, jsonb, text, timestamptz) to service_role;

commit;
