-- 終端服務中斷、自動接回做完之後，再通知本人一次結果：斷了幾位、接回幾位、哪幾位沒接回（#1818）。
-- 起因：11-20 工作機的終端服務崩潰，原本的 mux_down 通知只有「幾位受影響、正在自動接回」，事後沒有人知道接回了幾位、誰沒接回。
-- 新函式 asn_relay_mux_resume_notice(p_node, p_count, p_resumed, p_failed)：放在現有的 mux_down 通知種類，不新增種類；
--   名字清單由電腦端送來，這裡全部重新清過（去掉控制字元、去頭尾空白、每個最多 40 字、空的丟掉、同名只留一個）；
--   通知最多列 8 位，多的寫「等共 N 位」；沒接回的原因是技術細節，不進通知。
-- 原本的 asn_relay_mux_down_notice 一個字都不動（舊版電腦端照常用）。
-- security definer、search_path 空、只授權 service_role；碰到的資料表只有讀 relay.nodes，寄信經 asn_relay_send_notice。
-- 依賴：20261111100000_notice_center.sql。部署順序：本 migration → relay（Edge 收新動作）→ 新版 ASN。
--   提早上任何一步都不會壞：舊 Edge 沒有這個動作回 404、舊用戶端不會呼叫，電腦端只記 log 不重試。
-- 回復：supabase/sql/rollback/20261120100000_mux_resume_notice_down.sql（drop 新函式；不刪任何資料）。
begin;

create or replace function public.asn_relay_mux_resume_notice(p_node text, p_count integer, p_resumed integer, p_failed text[])
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
  v_names text[];
  v_shown text;
  v_failed_n integer;
begin
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_computer
    from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_count is null or p_count < 1 or p_count > 100 or p_resumed is null or p_resumed < 0 or p_resumed > p_count
     or p_failed is null or coalesce(array_length(p_failed, 1), 0) > 100 or p_resumed + coalesce(array_length(p_failed, 1), 0) <> p_count then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 名字清單重新清過：去控制字元、去頭尾空白、最多 40 字、空的丟掉、同名只留第一個（保持原順序）
  select coalesce(array_agg(n order by o), '{}') into v_names from (
    select distinct on (n) n, o from (
      select left(btrim(regexp_replace(coalesce(x, ''), '[[:cntrl:]]', '', 'g')), 40) as n, o
        from unnest(p_failed) with ordinality as t(x, o)
    ) c where n <> '' order by n, o
  ) d;
  v_failed_n := coalesce(array_length(v_names, 1), 0);
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    perform pg_advisory_xact_lock(hashtext('mux_resume_notice:' || p_node));
    v_shown := array_to_string(v_names[1:8], '、') || case when v_failed_n > 8 then '等共 ' || v_failed_n || ' 位' else '' end;
    v_body := coalesce(nullif(v_computer, ''), '未命名設備')
      || case
           when p_resumed = p_count
             then '：終端服務中斷，夥伴已全部接回' || E'\n' || '斷了 ' || p_count || ' 位，已接回 ' || p_resumed || ' 位。'
           when p_resumed = 0
             then '：終端服務中斷，夥伴沒有接回' || E'\n' || '斷了 ' || p_count || ' 位，沒有接回'
                  || case when v_failed_n > 0 then '：' || v_shown else '' end
                  || '。請到「' || coalesce(nullif(v_computer, ''), '未命名設備') || '」手動叫醒它們。'
           else '：終端服務中斷，部分夥伴還沒接回' || E'\n' || '斷了 ' || p_count || ' 位，已接回 ' || p_resumed || ' 位。還沒接回'
                  || case when v_failed_n > 0 then '：' || v_shown else '' end
                  || '。請到「' || coalesce(nullif(v_computer, ''), '未命名設備') || '」手動叫醒它們。'
         end;
    -- 和事故當下那則同一個種類（mux_down）；兩則加起來一次事故最多 2 則，限流看同一台一小時 6 則
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
revoke all on function public.asn_relay_mux_resume_notice(text, integer, integer, text[]) from public, anon, authenticated;
grant execute on function public.asn_relay_mux_resume_notice(text, integer, integer, text[]) to service_role;

commit;
