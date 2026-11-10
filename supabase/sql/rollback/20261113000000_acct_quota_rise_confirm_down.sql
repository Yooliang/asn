-- 退回 20261113000000_acct_quota_rise_confirm.sql：decide 換回 20261111200000 版本體（同期回升一律拒收）。
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

revoke all on function public.asn_relay_acct_window_decide(text, text, jsonb, jsonb, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_window_decide(text, text, jsonb, jsonb, jsonb, timestamptz) to service_role;

commit;
