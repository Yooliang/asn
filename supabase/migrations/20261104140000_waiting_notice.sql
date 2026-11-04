-- 夥伴卡在要人處理的框上超過兩分鐘時，通知這個節點自己的擁有者（todo-next-162；人可能在手機那頭）。
-- 做法照 20261102200000_misroute_notice.sql：收件人、寄件名、固定文字都在這裡決定。
--  asn_relay_waiting_notice(p_node, p_window, p_kind, p_detail, p_tool)：
--   - p_node 取自節點金鑰（Edge Function 帶入）。節點不存在或已停用回 forbidden。
--   - p_kind 只收 permission／input／other；p_detail 只有 input（選擇框的問題和選項）才採用，其他一律不寫進內文；p_tool 只有 permission 才採用，只收工具名的字元。
--   - 寄件名「等待確認收發室」（以「收發室」結尾，橋不會回覆它）；reply=no。
--   - 限流：同一節點每小時最多 6 封（advisory lock 串行計數）。同一扇視窗 30 分鐘一封由收發室判斷。
--   - 回傳 {ok:true, notify, bell_topics}：notify 是 'sent'／'failed'／'rate_limited'／'skipped'（擁有者查不到或核對不過）。
--   - 只授權 service_role；security definer、search_path 空。沒有改資料表、沒有改既有函式。
-- 部署順序：本 migration → relay（Edge Function，新動作 waiting_notice）→ 電腦端。提早上任何一步都不會壞。
-- 回復：supabase/sql/rollback/20261104140000_waiting_notice_down.sql（drop 這一支函式；已寄出的信不受影響）。
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
  v_window := left(btrim(regexp_replace(coalesce(p_window, ''), '[[:cntrl:]]', '', 'g')), 60);
  v_what := case p_kind when 'permission' then '在等你確認（權限' || case when p_tool ~ '^[A-Za-z0-9_.:-]{1,80}$' then '：' || p_tool else '' end || '）' when 'input' then '在等你回答' when 'other' then '在等你處理' end;
  if v_window = '' or v_what is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    perform pg_advisory_xact_lock(hashtext('waiting_notice:' || p_node));
    select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
      where from_node = p_node and from_agent = v_agent and created_at > now() - interval '1 hour';
    if v_recent >= 6 then
      v_notify := 'rate_limited';
    else
      v_body := '這台' || case when v_computer <> '' then '（' || v_computer || '）' else '' end || '的夥伴「' || v_window || '」' || v_what || '，已經等超過 2 分鐘。';
      if p_kind = 'input' and btrim(coalesce(p_detail, '')) <> '' then
        v_body := v_body || E'\n' || left(btrim(regexp_replace(p_detail, '[[:cntrl:]]', ' ', 'g')), 600);
      end if;
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
revoke all on function public.asn_relay_waiting_notice(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_waiting_notice(text, text, text, text, text) to service_role;

commit;
