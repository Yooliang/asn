-- 夥伴卡在要本人到電腦前確認的畫面時，通知這個節點自己的擁有者（todo-next-162；人可能在手機那頭）。
-- 做法照 20261102200000_misroute_notice.sql：由後台依節點查擁有者，收件人、寄件名、內文都在這裡決定，用戶端不能帶任何內容。
--  asn_relay_waiting_notice(p_node)：
--   - p_node 取自節點金鑰（Edge Function 帶入），沒有其他參數。節點不存在或已停用回 forbidden。
--   - 內文固定：「這台（設備名）有夥伴在等你到電腦前確認。」設備名讀 relay.nodes.name（去控制字元、最多 40 字，讀不到就省略括號）。不帶視窗名與畫面內容。
--   - 寄件名「等待確認收發室」（以「收發室」結尾，橋不會回覆它）；reply=no。
--   - 限流：同一節點每小時最多 1 封（advisory lock 串行計數）。
--   - 回傳 {ok:true, notify, bell_topics}：notify 是 'sent'／'failed'／'rate_limited'／'skipped'（擁有者查不到或核對不過）。
--   - 只授權 service_role；security definer、search_path 空。沒有改資料表、沒有改既有函式。
-- 部署順序：本 migration → relay（Edge Function，新動作 waiting_notice）→ 電腦端。提早上任何一步都不會壞（舊 Edge 沒有這個動作，電腦端只記 log）。
--   略過權限警告的偵測要先在乾淨環境驗過再部署；部署時機由 asn真 定。
-- 回復：supabase/sql/rollback/20261104090000_waiting_notice_down.sql（drop 這一支函式；已寄出的信不受影響）。
begin;

create or replace function public.asn_relay_waiting_notice(p_node text)
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
  v_agent constant text := '等待確認收發室';
begin
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_computer
    from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    perform pg_advisory_xact_lock(hashtext('waiting_notice:' || p_node));
    select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
      where from_node = p_node and from_agent = v_agent and created_at > now() - interval '1 hour';
    if v_recent >= 1 then
      v_notify := 'rate_limited';
    else
      v_body := '這台' || case when v_computer <> '' then '（' || v_computer || '）' else '' end || '有夥伴在等你到電腦前確認。';
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
revoke all on function public.asn_relay_waiting_notice(text) from public, anon, authenticated;
grant execute on function public.asn_relay_waiting_notice(text) to service_role;

commit;
