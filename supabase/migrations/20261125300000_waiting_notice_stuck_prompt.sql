-- 夥伴視窗卡在確認框超過 5 分鐘的保底通知（#2256）：asn_relay_waiting_notice 多收 p_kind = 'stuck_prompt'。
--  內文：「<設備名>：夥伴「<視窗名>」卡在確認框超過 5 分鐘」＋換行＋電腦端擷取的那一段畫面（p_detail，最多 600 字，換行保留、其他控制字元換成空白）。
--  只有 stuck_prompt 收 p_detail 當畫面片段；p_tool 一律不收。其他種類的行為與上一版逐字相同。
--  名額：沿用 notice:waiting（每節點每小時 6 封，和等待確認同一桶）。不新增通知種類，所以網頁不收的清單（web_denied_notice）不用動。
--  簽章、security definer、search_path、權限都和上一版相同（上一版：20261124100000_unnamed_device_label.sql）。
-- 部署順序：先本 migration、再 Edge（Edge 開始放行這個 kind）。舊 Edge＋新 DB：舊 Edge 把新 kind 擋成 400，電腦端當作「後台不認得」只留本機紀錄；新 Edge＋舊 DB：DB 回 bad_request（400），同樣只留紀錄。
-- 回復：supabase/sql/rollback/20261125300000_waiting_notice_stuck_prompt_down.sql
begin;

create or replace function public.asn_relay_waiting_notice(p_node text, p_window text, p_kind text, p_detail text default null, p_tool text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_computer text;
  v_window text;
  v_what text;
  v_reason text;
  v_count text;
  v_body text;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_notify text := 'skipped';
begin
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_computer
    from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  v_window := left(btrim(regexp_replace(coalesce(p_window, ''), '[[:cntrl:]]', '', 'g')), 60);
  v_what := case p_kind when 'permission' then '在等你確認（權限' || case when p_tool ~ '^[A-Za-z0-9_.:-]{1,80}$' then '：' || p_tool else '' end || '）' when 'input' then '在等你回答' when 'other' then '在等你處理' when 'login' then 'Claude 登入過期，要重新登入' when 'forward_stuck' then '收發室轉交連續被擋' when 'forward_stuck_manual' then '收發室轉交連續被擋' when 'stuck_prompt' then '卡在確認框超過 5 分鐘' end;
  if v_window = '' or v_what is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    perform pg_advisory_xact_lock(hashtext('waiting_notice:' || p_node));
    if p_kind in ('forward_stuck', 'forward_stuck_manual') then
      v_reason := case p_detail
        when 'frame' then '帶了信件外框' when 'no_id' then '第一行沒有轉交編號' when 'missing_fields' then '缺少收件人或內容'
        when 'recipient_conflict' then '兩個收件人欄位不一致' when 'wrong_to' then '收件人填錯' when 'head_mismatch' then '抬頭和原信不一致'
        when 'not_in_flight' then '這封信已不在轉交中' when 'record_unreadable' then '轉交紀錄暫時讀不到' else '原因不明' end;
      v_count := case when p_tool ~ '^[0-9]{1,2}$' then p_tool else '多' end;
      if p_kind = 'forward_stuck' then
        v_body := coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '：「' || v_window || '」' || v_what || ' ' || v_count || ' 次（原因：' || v_reason || '），已自動換一輪新的對話；排隊中的信會在新的一輪重新轉交。';
      else
        v_body := coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '：「' || v_window || '」' || v_what || ' ' || v_count || ' 次（原因：' || v_reason || '），已自動換過 3 輪還是被擋，已停止自動換輪，需要人工處理（請重開這台的收發室）。';
      end if;
    elsif p_kind = 'login' then
      v_body := coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '：「' || v_window || '」' || v_what || '。';
    elsif p_kind = 'stuck_prompt' then
      v_body := coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '：夥伴「' || v_window || '」' || v_what;
      -- 畫面片段：換行留著，其他控制字元換成空白，最多 600 字
      -- 先清理再判斷：只有 tab、換行、空白的片段清完是空的，就不接（btrim 不剪 tab 與換行）
      v_reason := left(btrim(regexp_replace(coalesce(p_detail, ''), '[\x01-\x09\x0b-\x1f\x7f]', ' ', 'g'), E' \n'), 600);
      if v_reason <> '' then
        v_body := v_body || E'\n' || v_reason;
      end if;
    else
      v_body := coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '：夥伴「' || v_window || '」' || v_what || E'\n' || '已經等超過 2 分鐘。';
    end if;
    if p_kind = 'input' and btrim(coalesce(p_detail, '')) <> '' then
      v_body := v_body || E'\n' || left(btrim(regexp_replace(p_detail, '[[:cntrl:]]', ' ', 'g')), 600);
    end if;
    -- 登入過期、轉交被擋各用自己的種類：名額（每節點每小時 6 封）與等待確認的 6 封分開算；卡在確認框沿用等待確認那一桶
    v_res := public.asn_relay_send_notice(p_node, case when p_kind = 'login' then 'waiting_login' when p_kind in ('forward_stuck', 'forward_stuck_manual') then 'forward_stuck' else 'waiting' end, v_body, 6, interval '1 hour');
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
revoke all on function public.asn_relay_waiting_notice(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_waiting_notice(text, text, text, text, text) to service_role;

commit;
