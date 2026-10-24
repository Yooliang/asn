-- 帳號回報可帶各 Claude 帳號的剩餘額度（#228）：讓電腦版與手機版的「設備與帳號」挑有額度的帳號來切換。
-- 只改一支函式（以 20261023160000_acct_report_vendors.sql 為基礎）並新增一支內部小工具：
--   1. asn_relay_acct_quota：把一列回報裡的額度欄位整理成乾淨的 jsonb（全部選填；不合格的欄位單獨丟掉，不退回整份）。
--      five_hour_pct／weekly_pct＝剩餘百分比（0～100，取整）；reset_at＝重置時間；at＝那台電腦記下數字的時間（不得晚於現在 10 分鐘以上）。
--      沒有合格的百分比、或沒有合格的 at，就整組不收（回空物件）。
--   2. asn_relay_acct_report：只有 vendor 為 claude 的列才收額度；其餘行為與以前完全相同（仍只留 vendor／email／plan／current 加上額度四欄，最多 20 筆）。
-- 資料表不用改：relay.asn_accounts.accounts 本來就是 jsonb；asn_relay_acct_list 原樣回傳 accounts，所以手機與電腦讀到時自然帶著額度。
-- 相容：舊用戶端不帶額度＝與以前完全相同；新用戶端打到還沒套這支的舊後台時，多出來的欄位會被舊函式丟掉，不會壞。
-- 部署順序：migration → Edge Function（relay，parseReport 同步放行額度欄位）→ 發新版 ASN（電腦）→ 發新版手機。先不套用。
-- 回復：換回 20261023160000_acct_report_vendors.sql 的 asn_relay_acct_report，並 drop function public.asn_relay_acct_quota(jsonb)。
begin;

create or replace function public.asn_relay_acct_quota(p_row jsonb)
 returns jsonb
 language plpgsql
 set search_path to ''
as $function$
declare
  v_five numeric;
  v_week numeric;
  v_at timestamptz;
  v_reset timestamptz;
  v_out jsonb := '{}'::jsonb;
begin
  if jsonb_typeof(p_row->'five_hour_pct') = 'number' and (p_row->>'five_hour_pct')::numeric between 0 and 100 then
    v_five := round((p_row->>'five_hour_pct')::numeric);
  end if;
  if jsonb_typeof(p_row->'weekly_pct') = 'number' and (p_row->>'weekly_pct')::numeric between 0 and 100 then
    v_week := round((p_row->>'weekly_pct')::numeric);
  end if;
  begin
    if jsonb_typeof(p_row->'at') = 'string' and char_length(p_row->>'at') <= 40 then
      v_at := (p_row->>'at')::timestamptz;
    end if;
  exception when others then
    v_at := null;
  end;
  begin
    if jsonb_typeof(p_row->'reset_at') = 'string' and char_length(p_row->>'reset_at') <= 40 then
      v_reset := (p_row->>'reset_at')::timestamptz;
    end if;
  exception when others then
    v_reset := null;
  end;
  if (v_five is null and v_week is null) or v_at is null or v_at > clock_timestamp() + interval '10 minutes' then
    return '{}'::jsonb;
  end if;
  if v_five is not null then v_out := v_out || jsonb_build_object('five_hour_pct', v_five::int); end if;
  if v_week is not null then v_out := v_out || jsonb_build_object('weekly_pct', v_week::int); end if;
  if v_reset is not null then v_out := v_out || jsonb_build_object('reset_at', to_char(v_reset at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')); end if;
  return v_out || jsonb_build_object('at', to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
end;
$function$;

create or replace function public.asn_relay_acct_report(p_node text, p_accounts jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_row jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  if p_accounts is null or jsonb_typeof(p_accounts) <> 'array' or jsonb_array_length(p_accounts) > 20 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active') then
    return jsonb_build_object('error', 'not_found');
  end if;
  for v_row in select * from jsonb_array_elements(p_accounts) loop
    if jsonb_typeof(v_row) <> 'object'
       or v_row->>'vendor' is null or v_row->>'vendor' not in ('claude', 'codex')
       or not public.asn_relay_acct_email_ok(v_row->>'email')
       or (v_row ? 'plan' and (jsonb_typeof(v_row->'plan') <> 'string' or char_length(v_row->>'plan') > 30 or (v_row->>'plan') ~ '[[:cntrl:]]'))
       or (v_row ? 'current' and jsonb_typeof(v_row->'current') <> 'boolean') then
      return jsonb_build_object('error', 'bad_request');
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'vendor', v_row->>'vendor', 'email', v_row->>'email', 'plan', coalesce(v_row->>'plan', ''), 'current', coalesce((v_row->>'current')::boolean, false))
      || case when v_row->>'vendor' = 'claude' then public.asn_relay_acct_quota(v_row) else '{}'::jsonb end);
  end loop;
  insert into relay.asn_accounts (node, accounts, updated_at) values (p_node, v_out, now())
    on conflict (node) do update set accounts = excluded.accounts, updated_at = excluded.updated_at;
  return jsonb_build_object('ok', true, 'count', jsonb_array_length(v_out));
end;
$function$;

revoke all on function public.asn_relay_acct_quota(jsonb) from public, anon, authenticated;
revoke all on function public.asn_relay_acct_report(text, jsonb) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_quota(jsonb) to service_role;
grant execute on function public.asn_relay_acct_report(text, jsonb) to service_role;

commit;
