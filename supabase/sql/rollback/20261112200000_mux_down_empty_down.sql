-- 回復檔（不是 migration，不會被部署；要用時人工執行）。
-- 回復 20261112200000_mux_down_empty.sql：asn_relay_mux_down_notice 逐字換回 20261111100000_notice_center.sql 的版本（p_count 下限 1）；drop 新函式 asn_relay_mux_blind_notice。不刪任何資料（已寄出的通知信留著）。
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
  if p_count is null or p_count < 1 or p_count > 100 or p_resumed is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    perform pg_advisory_xact_lock(hashtext('mux_down_notice:' || p_node));
    v_body := coalesce(nullif(v_computer, ''), '未命名設備')
      || case when p_resumed
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

drop function if exists public.asn_relay_mux_blind_notice(text);

commit;
