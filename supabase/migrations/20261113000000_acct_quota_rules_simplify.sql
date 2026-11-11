-- 額度規則簡化（#1266）：帳號由來源確定之後，後台不再靠數字猜「是不是別的帳號」。
--
-- 前提（客戶端同一批改動）：Claude 的 read_at 改成對話紀錄裡最後一筆 assistant 回應的時間（舊視窗重送舊數字時，read_at 就是舊的）；
-- 記到哪個帳號由視窗自己的帳號身分決定；沒帶身分的舊版 Claude Code 不收。Gemini、Grok、MiniMax 的帳號本來就由來源確定。
--
-- 這支做的事：
--  1. asn_relay_acct_window_judge：只剩「新的重置時間要在現在 −1 天到 +8 天之間」。拿掉的規則與理由：
--     same_period_rise（同一期剩餘回升）：滾動窗與四捨五入的回升是合法的，硬擋會讓整個窗停更（11-09 工作機 01:06Z 到 04:58Z）；
--     earlier／later_not_expired／not_week_multiple 與待確認：都是靠重置時間猜別的帳號，帳號由來源確定後沒有意義，閒置後新一期起點移位也被它擋（#1184）；
--     Gemini／MiniMax 記著 100% 的例外：只為了繞過上面這些規則；舊值 +8 天自解鎖、過期超過 7 天照收：舊值不再參與比較，不需要。
--  2. asn_relay_acct_window_decide：只剩 future_read（讀取時間比現在晚超過 5 分鐘）→ older_read（讀取時間比已存的早）→ judge 的範圍檢查。
--     簽名不變，pending 一律回 null；roster_report 照舊用回傳值更新 window_pending，所以舊版留下的待確認會被清掉。
--  3. asn_relay_acct_windows_clean：除了下列片段與 20261110100000 版逐字相同——拿掉「讀取時間比現在晚 10 分鐘」的靜默丟棄，
--     只留「沒有讀取時間就丟」。理由：它和 future_read（5 分鐘）重複，留 future_read 是因為被擋時有原因代碼、看得到，而且門檻較嚴。
--  4. 不動 asn_relay_acct_roster_report、任何資料表。relay.asn_user_accounts.window_pending 欄位保留（不 drop），之後不再寫入內容：
--     舊版 relay 或回復到上一版時還會用到它。
-- 原因代碼只剩 older_read、future_read、reset_out_of_range。
-- 權限：維持只給 service_role。部署順序：本 migration → relay（Edge Function，不需改）→ 電腦端。
-- 回復：supabase/sql/rollback/20261113000000_acct_quota_rules_simplify_down.sql（換回三支函式的上一版本體）。
begin;

create or replace function public.asn_relay_acct_window_judge(p_vendor text, p_name text, p_old jsonb, p_new jsonb, p_now timestamptz)
 returns text
 language plpgsql
 stable
 set search_path to ''
as $function$
declare
  v_new_r timestamptz;
begin
  -- 新的重置時間要在「現在 −1 天」到「現在 +8 天」之間（含兩端），不然一個 2099 年的重置時間存進來會鎖死那一窗。
  -- 其餘不再比較（同一期回升、重置時間往前往後、7 天倍數都是合法的新數字；舊視窗重送的舊數字由 decide 的 older_read 擋）。
  if jsonb_typeof(p_new->'resets_at') = 'string' then
    v_new_r := (p_new->>'resets_at')::timestamptz;
    if v_new_r < p_now - interval '1 day' or v_new_r > p_now + interval '8 days' then
      return 'reset_out_of_range';
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
begin
  -- 讀取時間比後台現在晚超過 5 分鐘＝電腦時鐘走快，拒收（否則這筆會一直贏過正常的）
  if jsonb_typeof(p_new->'read_at') = 'string' and (p_new->>'read_at')::timestamptz > p_now + interval '5 minutes' then
    return jsonb_build_object('reason', 'future_read', 'pending', null::jsonb);
  end if;
  -- 讀取時間比已存的更早＝舊視窗重送的舊數字，不收（兩邊都有讀取時間才比；同一時間照收）
  if p_old is not null and jsonb_typeof(p_old->'read_at') = 'string' and jsonb_typeof(p_new->'read_at') = 'string'
     and (p_new->>'read_at')::timestamptz < (p_old->>'read_at')::timestamptz then
    return jsonb_build_object('reason', 'older_read', 'pending', null::jsonb);
  end if;
  -- 重置時間範圍（judge 只剩這一條）
  v_reason := public.asn_relay_acct_window_judge(p_vendor, p_name, p_old, p_new, p_now);
  -- 待確認（window_pending）不再使用：一律回 null，report 會把舊版留下的待確認清掉
  return jsonb_build_object('reason', v_reason, 'pending', null::jsonb);
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
    -- 讀取時間在未來太多的，由 decide 的 future_read 擋（有原因代碼、看得到），這裡只丟掉沒有讀取時間的
    continue when v_read is null;
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
