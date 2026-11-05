-- 共用終端服務（mux）掛掉時，通知這個節點自己的擁有者（#596 第 4 項）。
-- 做法照 20261104140000_waiting_notice.sql：收件人、寄件名、固定文字都在這裡決定。
--  asn_relay_mux_down_notice(p_node, p_count, p_resumed)：
--   - p_node 取自節點金鑰（Edge Function 帶入）。節點不存在或已停用回 forbidden。
--   - p_count 是中斷的夥伴數，只收 1～100；內文不帶夥伴名字和畫面內容。
--   - p_resumed：true＝ASN 正在自動接回；false＝短時間內又掛，這次沒有接回，請本人處理。
--   - 寄件名「終端服務收發室」（以「收發室」結尾，橋不會回覆它）；reply=no。
--   - 限流：同一節點每小時最多 6 封（advisory lock 串行計數）。一次事故只呼叫一次由電腦端判斷。
--   - 回傳 {ok:true, notify, bell_topics}：notify 是 'sent'／'failed'／'rate_limited'／'skipped'（擁有者查不到或核對不過）。
--   - 只授權 service_role；security definer、search_path 空。沒有改資料表、沒有改既有函式。
-- 部署順序：本 migration → relay（Edge Function，新動作 mux_down_notice）→ 電腦端。舊後台回 404，電腦端只留本機提示。
-- 回復：supabase/sql/rollback/20261105110000_mux_down_notice_down.sql（drop 這一支函式；已寄出的信不受影響）。
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
  v_recent int;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_notify text := 'skipped';
  v_agent constant text := '終端服務收發室';
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
    select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
      where from_node = p_node and from_agent = v_agent and created_at > now() - interval '1 hour';
    if v_recent >= 6 then
      v_notify := 'rate_limited';
    else
      v_body := '這台' || case when v_computer <> '' then '（' || v_computer || '）' else '' end
        || case when p_resumed
             then '的終端服務中斷了，' || p_count || ' 位夥伴受影響，ASN 正在自動接回。'
             else '的終端服務短時間內又中斷了，' || p_count || ' 位夥伴受影響。這次沒有自動接回，請到這台電腦看一下。'
           end;
      v_res := public.asn_relay_send(p_node, v_agent, public.asn_person_alias(v_owner), null, v_body, null, false, null, false);
      if v_res is null or v_res ? 'error' then
        v_notify := 'failed';
      else
        v_notify := 'sent';
        v_topics := case
          when jsonb_typeof(v_res->'bell_topics') = 'array' then v_res->'bell_topics'
          when jsonb_typeof(v_res->'bell_topic') = 'string' then jsonb_build_array(v_res->'bell_topic')
          else '[]'::jsonb end;
      end if;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'notify', v_notify, 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_mux_down_notice(text, integer, boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_mux_down_notice(text, integer, boolean) to service_role;

commit;
