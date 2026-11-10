-- 橋的回信寄件匣存檔壞了：通知本人（Yooliang/asn#1249 第 1 條）。
-- 橋啟動時發現寄件匣存檔讀不回來，會把它改名留著；裡面還沒寄出的回信無法再寄。原本只留一行本機 log，沒有人會知道。
-- 新函式 asn_relay_outbox_bad_notice(p_node)：橋呼叫一次，通知節點擁有者（同一台每小時最多一則，由 asn_relay_send_notice 限流）。
-- 通知內文固定，沒有任何參數可以帶文字進來，不含任何回信內文。
-- security definer、search_path 空、只授權 service_role；只讀 relay.nodes、經 asn_relay_send_notice 寄信（寫法同 asn_relay_mux_blind_notice）。
-- 依賴：20261111100000_notice_center.sql。部署順序：本 migration → relay（Edge 新增 outbox_bad_notice）→ 新版 ASN。
--   提早上任何一步都不會壞：舊 Edge 回 404、舊資料庫回 500，橋只記 log、不重試。
-- 回復：supabase/sql/rollback/20261112600000_outbox_bad_notice_down.sql（drop 新函式；不刪任何資料）。
begin;

create or replace function public.asn_relay_outbox_bad_notice(p_node text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_body text;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_notify text := 'skipped';
begin
  select owner_user into v_owner from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    v_body := '這台電腦的回信寄件匣檔案壞了，裡面還沒寄出的回信無法再寄，可能有夥伴的回信沒送到對方。';
    v_res := public.asn_relay_send_notice(p_node, 'outbox_bad', v_body, 1, interval '1 hour');
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
revoke all on function public.asn_relay_outbox_bad_notice(text) from public, anon, authenticated;
grant execute on function public.asn_relay_outbox_bad_notice(text) to service_role;

commit;
