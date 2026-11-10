-- 終端服務停了也要通知：服務裡沒有夥伴（p_count = 0）時，只通知「這台的終端服務停了」（asn真 11-10 交辦）。
-- 起因：11-10 30家用 的終端服務崩潰（0xc00000fd）後，電腦端一直沒有任何訊號；監看原本「裡面沒有夥伴就不記」，沒有夥伴的服務停了更不會通知。
-- 1. asn_relay_mux_down_notice：p_count 下限由 1 改成 0，0 用固定的新句型；1～100 的句型一字不改。
-- 2. 新函式 asn_relay_mux_blind_notice(p_node)：電腦端監看連續約 5 分鐘看不到終端服務時，通知本人一次（同一台 24 小時一則）。
-- security definer、search_path 空、只授權 service_role 都照舊；碰到的資料表與上一版相同（讀 relay.nodes，經 asn_relay_send_notice 寄信）。
-- 依賴：20261111100000_notice_center.sql（本函式由它的版本改起）。部署順序：本 migration → relay（Edge 收 count 0）→ 新版 ASN。
--   提早上任何一步都不會壞：舊 Edge 擋 count 0 回 400、舊函式回 bad_request，電腦端只記 log 不重試。
-- 回復：supabase/sql/rollback/20261112200000_mux_down_empty_down.sql（mux_down 逐字換回通知集中那一版、drop 新函式；不刪任何資料）。
begin;

create or replace function public.asn_relay_mux_down_notice(p_node text, p_count integer, p_resumed boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_computer text;
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
  -- 0＝服務裡沒有夥伴：只通知服務停了（11-10 30家用：裡面沒有夥伴時崩潰、被帶走都沒有任何訊號）
  if p_count is null or p_count < 0 or p_count > 100 or p_resumed is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    perform pg_advisory_xact_lock(hashtext('mux_down_notice:' || p_node));
    v_body := coalesce(nullif(v_computer, ''), '未命名設備')
      || case when p_count = 0
           then '：這台的終端服務停了' || E'\n' || '目前沒有夥伴在裡面，不用接回；下次開夥伴時會自動重新啟動。'
         when p_resumed
           then '：終端服務中斷了' || E'\n' || p_count || ' 位夥伴受影響，ASN 正在自動接回。'
           else '：終端服務短時間內又中斷了' || E'\n' || p_count || ' 位夥伴受影響。這次沒有自動接回，請到「' || coalesce(nullif(v_computer, ''), '未命名設備') || '」看一下。'
         end;
    v_res := public.asn_relay_send_notice(p_node, 'mux_down', v_body, 6, interval '1 hour');
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
revoke all on function public.asn_relay_mux_down_notice(text, integer, boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_mux_down_notice(text, integer, boolean) to service_role;

-- 監看連續看不到終端服務（電腦端判斷，約 5 分鐘）：通知本人一次（同一台 24 小時最多一則，由 asn_relay_send_notice 限流）
-- 只讀 relay.nodes、經 asn_relay_send_notice 寄固定句型；沒有參數可以帶文字進來
create or replace function public.asn_relay_mux_blind_notice(p_node text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_computer text;
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
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    v_body := coalesce(nullif(v_computer, ''), '未命名設備') || '：ASN 看不到終端服務的狀態' || E'\n'
      || '已經約 5 分鐘看不到，這段期間夥伴的窗格出事時不會自動接回。請重開 ASN；重開後還是這樣，請回報。';
    v_res := public.asn_relay_send_notice(p_node, 'mux_blind', v_body, 1, interval '24 hours');
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
revoke all on function public.asn_relay_mux_blind_notice(text) from public, anon, authenticated;
grant execute on function public.asn_relay_mux_blind_notice(text) to service_role;

commit;
