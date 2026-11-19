-- 登入過期推播（#1792）：asn_relay_waiting_notice 多收 p_kind = 'login'。
--  內文：「<設備名>：「<視窗名>」Claude 登入過期，要重新登入。」（沒有「已經等超過 2 分鐘」）；視窗名取自 p_window，其餘規則不變。
--  名額：login 的寄件種類是 waiting_login（kind = notice:waiting_login），限流看「節點＋種類」，所以每節點每小時 6 封只算登入通知，
--        不吃等待確認（waiting）的 6 封，反過來也不被它吃掉。用戶端另外保證同一視窗每次停住只推一次、至少隔 30 分鐘。
--  簽章、security definer、search_path、權限都和上一版相同（上一版：20261111100000_notice_center.sql）。
-- 部署順序：先本 migration、再 Edge（Edge 開始放行 kind=login）。舊 Edge＋新 DB：舊 Edge 把 login 擋成 400，無害；新 Edge＋舊 DB：DB 回 bad_request，電腦端記 log、60 秒後再試。
-- 回復：supabase/sql/rollback/20261119400000_waiting_notice_login_down.sql
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
  v_what := case p_kind when 'permission' then '在等你確認（權限' || case when p_tool ~ '^[A-Za-z0-9_.:-]{1,80}$' then '：' || p_tool else '' end || '）' when 'input' then '在等你回答' when 'other' then '在等你處理' when 'login' then 'Claude 登入過期，要重新登入' end;
  if v_window = '' or v_what is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    perform pg_advisory_xact_lock(hashtext('waiting_notice:' || p_node));
    if p_kind = 'login' then
      v_body := coalesce(nullif(v_computer, ''), '未命名設備') || '：「' || v_window || '」' || v_what || '。';
    else
      v_body := coalesce(nullif(v_computer, ''), '未命名設備') || '：夥伴「' || v_window || '」' || v_what || E'\n' || '已經等超過 2 分鐘。';
    end if;
    if p_kind = 'input' and btrim(coalesce(p_detail, '')) <> '' then
      v_body := v_body || E'\n' || left(btrim(regexp_replace(p_detail, '[[:cntrl:]]', ' ', 'g')), 600);
    end if;
    -- 登入過期用自己的種類（notice:waiting_login）：名額（每節點每小時 6 封）與等待確認的 6 封分開算
    v_res := public.asn_relay_send_notice(p_node, case when p_kind = 'login' then 'waiting_login' else 'waiting' end, v_body, 6, interval '1 hour');
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

-- 網頁（#1766）不收的通知種類：多加登入過期（waiting_login）
create or replace function relay.web_denied_notice(p_kind text)
 returns boolean language sql immutable set search_path to ''
as $function$
  select p_kind in ('notice:login', 'notice:waiting', 'notice:device_key', 'notice:view', 'notice:waiting_login');
$function$;
revoke all on function relay.web_denied_notice(text) from public, anon, authenticated;

commit;
