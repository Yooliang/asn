-- 雲端代理啟動時發現「金鑰對到的節點」和「設定的節點」不同，停下來之前通知本人（#832）。
-- 做法照 20261105110000_mux_down_notice.sql：收件人、寄件名、文字都在這裡決定。
--  asn_relay_node_mismatch_notice(p_node, p_configured)：
--   - p_node 取自節點金鑰（Edge Function 帶入）＝金鑰實際對到的節點。節點不存在或已停用回 forbidden。
--   - p_configured 是代理設定的節點代號，代理只能帶這一個參數。符合代號格式、而且是同一個擁有者名下啟用中的節點，
--     信裡才寫出它的設備名；否則一律寫「另一個節點」。代理帶來的字不會原樣進信裡。
--   - 收件人是 p_node 的擁有者；寄件名「雲端設定收發室」（以「收發室」結尾，橋不會回覆它）；reply=no。
--   - 限流：同一節點每小時最多 1 封；同樣的內容 24 小時內不重寄（advisory lock 串行判斷）。
--   - 回傳 {ok:true, notify, bell_topics}：notify 是 'sent'／'failed'／'rate_limited'／'duplicate'／'skipped'（擁有者查不到或核對不過）。
--   - 只授權 service_role；security definer、search_path 空。沒有改資料表、沒有改既有函式。
-- 部署順序：本 migration → relay（Edge Function，新動作 node_mismatch_notice）→ 雲端代理。舊後台回 404，代理照樣停下來、只寫紀錄。
-- 回復：supabase/sql/rollback/20261106130000_node_mismatch_notice_down.sql（drop 這一支函式；已寄出的信不受影響）。
begin;

create or replace function public.asn_relay_node_mismatch_notice(p_node text, p_configured text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_here text;
  v_other text;
  v_body text;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_notify text := 'skipped';
  v_agent constant text := '雲端設定收發室';
begin
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_here
    from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_configured is null or p_configured !~ '^[A-Za-z0-9_-]{1,32}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    if p_configured <> p_node then
      select nullif(left(btrim(regexp_replace(coalesce(n.name, ''), '[[:cntrl:]]', '', 'g')), 40), '') into v_other
        from relay.nodes n where n.id = p_configured and n.owner_user = v_owner and n.status = 'active';
    end if;
    v_body := '有一台雲端代理啟動時發現設定不對：它設定的是'
      || case when v_other is not null then '「' || v_other || '」' else '另一個節點' end
      || '，但金鑰對到的是這台' || case when v_here <> '' then '（' || v_here || '）' else '' end
      || '。可能是貼上另一組設定時把金鑰蓋掉了。為了不用錯的身分收發信，它已經停下來；請把那邊的設定改回同一組再啟動。';
    perform pg_advisory_xact_lock(hashtext('node_mismatch_notice:' || p_node));
    if exists (select 1 from relay.messages where from_node = p_node and from_agent = v_agent and created_at > now() - interval '1 hour') then
      v_notify := 'rate_limited';
    elsif exists (select 1 from relay.messages where from_node = p_node and from_agent = v_agent and body = v_body and created_at > now() - interval '24 hours') then
      v_notify := 'duplicate';
    else
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
revoke all on function public.asn_relay_node_mismatch_notice(text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_node_mismatch_notice(text, text) to service_role;

commit;
