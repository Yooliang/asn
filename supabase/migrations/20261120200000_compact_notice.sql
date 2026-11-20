-- 視窗壓縮次數到了之後，通知本人這次是自動交接了，還是只提醒請交接（#1852）。
-- 起因：#1852 壓縮交接——夥伴的視窗壓縮到一定次數會變笨，電腦端會在額度夠時自動交給新視窗，額度不夠或自動交接做不到時只寄信提醒；
--   這兩種結果都要讓本人知道。文案照 docs/design/1852-compact-handoff/mail.html。
-- 新函式 asn_relay_compact_notice(p_node, p_window, p_count, p_kind, p_reason, p_pct)：通知種類用新的 compact（kind＝notice:compact），
--   asn_relay_send_notice 的種類只檢查格式（^[a-z_]{1,30}$），沒有白名單，不用另外補。
--   p_kind 只收 auto／remind_quota／remind_unknown／remind_off／remind_failed，其他值回 bad_request；
--   p_window 這裡重新清過（去控制字元、去頭尾空白、最多 40 字、空的回 bad_request）；p_count 1～100；p_pct 可空、0～100；
--   p_reason 只有 remind_quota 要帶，且只能是「5 小時」或「每週」，其他種類必須是空的。
-- security definer、search_path 空、只授權 service_role；碰到的資料表只有讀 relay.nodes，寄信經 asn_relay_send_notice（同一台一小時最多 6 則）。
-- 依賴：20261111100000_notice_center.sql。部署順序：本 migration → relay（Edge 收新動作）→ 新版 ASN。
--   提早上任何一步都不會壞：舊 Edge 沒有這個動作回 404、舊用戶端不會呼叫，電腦端只記 log 不重試。
-- 回復：supabase/sql/rollback/20261120200000_compact_notice_down.sql（drop 新函式；不刪任何資料）。
begin;

create or replace function public.asn_relay_compact_notice(p_node text, p_window text, p_count integer, p_kind text, p_reason text, p_pct integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_computer text;
  v_win text;
  v_dev text;
  v_body text;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_notify text := 'skipped';
  v_how text;
begin
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_computer
    from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  v_win := left(btrim(regexp_replace(coalesce(p_window, ''), '[[:cntrl:]]', '', 'g')), 40);
  if v_win = ''
     or p_count is null or p_count < 1 or p_count > 100
     or p_kind is null or p_kind not in ('auto', 'remind_quota', 'remind_unknown', 'remind_off', 'remind_failed')
     or (p_pct is not null and (p_pct < 0 or p_pct > 100))
     or (p_kind = 'remind_quota' and (p_reason is null or p_reason not in ('5 小時', '每週')))
     or (p_kind <> 'remind_quota' and p_reason is not null) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  v_dev := coalesce(nullif(v_computer, ''), '未命名設備');
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    perform pg_advisory_xact_lock(hashtext('compact_notice:' || p_node));
    v_how := '到 設定 → 設備 → ' || v_dev || ' → 工作管理員，按「交接」。';
    v_body := v_dev || '：' || v_win || ' 壓縮 ' || p_count || ' 次，' || case when p_kind = 'auto' then '已自動交接' else '請交接' end || E'\n'
      || case p_kind
           when 'auto'
             then '「' || v_win || '」這次開窗後已壓縮 ' || p_count || ' 次，額度還夠，已經交給新視窗接手。' || E'\n'
                  || '做了這些：查額度' || case when p_pct is not null then '（5 小時剩 ' || p_pct || '%）' else '' end || '、寫交接檔、開新視窗、關掉舊視窗。' || E'\n'
                  || '新視窗的名字還是「' || v_win || '」，壓縮次數從 0 次算起。' || E'\n'
                  || '不想自動交接：設定 → 視窗與系統匣，取消勾選「壓縮 ' || p_count || ' 次自動交接」。'
           when 'remind_quota'
             then '「' || v_win || '」這次開窗後已壓縮 ' || p_count || ' 次，額度不夠（' || p_reason || case when p_pct is not null then '剩 ' || p_pct || '%' else '' end || '），沒有自動交接。' || E'\n'
                  || '做了這些：只寄這封信，沒有動那個視窗。' || E'\n'
                  || '額度恢復後，' || v_how
           when 'remind_unknown'
             then '「' || v_win || '」這次開窗後已壓縮 ' || p_count || ' 次，讀不到額度，沒有自動交接。' || E'\n'
                  || '做了這些：只寄這封信，沒有動那個視窗。' || E'\n'
                  || v_how
           when 'remind_off'
             then '「' || v_win || '」這次開窗後已壓縮 ' || p_count || ' 次。你在設定裡取消了自動交接，所以只提醒。' || E'\n'
                  || v_how
           else
                  '「' || v_win || '」這次開窗後已壓縮 ' || p_count || ' 次，自動交接沒成功，沒有動那個視窗，所以只提醒。' || E'\n'
                  || '做了這些：只寄這封信，沒有動那個視窗。' || E'\n'
                  || v_how
         end;
    v_res := public.asn_relay_send_notice(p_node, 'compact', v_body, 6, interval '1 hour');
    if v_res is null or v_res ? 'error' then
      v_notify := 'failed';
    else
      v_notify := coalesce(v_res ->> 'notify', 'failed');
      v_topics := coalesce(v_res -> 'bell_topics', '[]'::jsonb);
    end if;
  end if;
  return jsonb_build_object('ok', true, 'notify', v_notify, 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_compact_notice(text, text, integer, text, text, integer) from public, anon, authenticated;
grant execute on function public.asn_relay_compact_notice(text, text, integer, text, text, integer) to service_role;

commit;
