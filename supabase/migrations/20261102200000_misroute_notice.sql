-- 核對轉交對象：收發室把信轉交到不是預定收件人的視窗時，通知「這個節點自己的擁有者」（可能人在手機那頭，不寄到本機視窗）。
-- 做法照 20261102160000_inbox_hold_until.sql 的 asn_relay_set_inbox_hold 寄給擁有者的那段，與 20261031110000_acct_login_alert_notify.sql 的
-- asn_relay_login_alert：由後台依節點查擁有者（relay.nodes.owner_user、asn_user_owns_node、asn_person_alias），收件人、寄件名、內文格式都在這裡決定，
-- 最後呼叫既有的 asn_relay_send。
--  asn_relay_misroute_notice(p_node, p_mail_id)：
--   - p_node 取自節點金鑰（Edge Function 帶入）；沒有收件人參數，收件人只能是這個節點自己的擁有者。節點不存在或已停用回 forbidden。
--   - 內文固定：「這台（設備名）的收發室把一封信（編號 …）轉交錯了視窗，可能已被讀取；收發室正在重新轉交給原收件人。」
--     設備名讀 relay.nodes.name（去控制字元、最多 40 字，讀不到就省略括號）；p_mail_id 為空（群組訊息）時改寫「一則訊息」不帶編號。
--     不帶任何視窗名，也不帶信件內文。編號只是呼叫端給的 uuid 型別值，這裡不查它存不存在（限流與固定內文已把濫用的影響壓到最小）。
--   - 寄件名「轉交核對收發室」（以「收發室」結尾，橋不會回覆它）；reply=no。
--   - 限流：同一節點每小時最多 3 封（advisory lock 串行計數）。
--   - 回傳 {ok:true, notify, bell_topics}：notify 是 'sent'／'failed'（asn_relay_send 回了錯誤）／'rate_limited'／'skipped'（擁有者查不到或核對不過）。
--   - 只授權 service_role；security definer、search_path 空。沒有改資料表、沒有改既有函式。
-- 部署順序：本 migration → relay（Edge Function，新動作 misroute_notice）→ 電腦端。提早上任何一步都不會壞（舊 Edge 沒有這個動作，電腦端得到 404，只記 log）。
--   部署：npx supabase db query --linked -f supabase/migrations/20261102200000_misroute_notice.sql
-- 回復：supabase/sql/rollback/20261102200000_misroute_notice_down.sql（drop 這一支函式；已寄出的信不受影響）。
begin;

create or replace function public.asn_relay_misroute_notice(p_node text, p_mail_id uuid default null)
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
  v_agent constant text := '轉交核對收發室';
begin
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_computer
    from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    perform pg_advisory_xact_lock(hashtext('misroute_notice:' || p_node));
    select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
      where from_node = p_node and from_agent = v_agent and created_at > now() - interval '1 hour';
    if v_recent >= 3 then
      v_notify := 'rate_limited';
    else
      v_body := '這台' || case when v_computer <> '' then '（' || v_computer || '）' else '' end || '的收發室把'
        || case when p_mail_id is null then '一則訊息' else '一封信（編號 ' || p_mail_id::text || '）' end
        || '轉交錯了視窗，可能已被讀取；收發室正在重新轉交給原收件人。';
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
revoke all on function public.asn_relay_misroute_notice(text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_misroute_notice(text, uuid) to service_role;

commit;
