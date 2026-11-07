-- App 關著手機也要響（#797，FCM 推播）PR②：Edge 要推給「收件的那個人」，這個人只能從伺服器端取得。
-- 既有的寄信函式（asn_relay_send_core）與夥伴等待通知（asn_relay_waiting_notice）的回傳不帶收件人，而它們一個字都不改；
-- 所以新增兩個只讀的小函式，讓 Edge 用「自己剛寄出的那封信」或「金鑰所屬的節點」問出收件人，不接受任何用戶端給的人：
--   * asn_relay_push_recipient_mail(p_node, p_message_id)：寄給本人（扇出到本人各 ASN 的那條路）的信，回信上記的收件人（person_user）。
--     p_message_id 是 Edge 剛從寄信結果拿到的信編號；信必須是 p_node（金鑰所屬節點）寄出的，否則回空。
--   * asn_relay_push_recipient_node(p_node)：夥伴等待通知的收件人＝這個節點的擁有者（啟用中的節點才有）。
-- 只給 service_role，只回一個 user 欄位，不回權杖、信件內容或其他資料。
-- 回復：drop function asn_relay_push_recipient_mail, asn_relay_push_recipient_node。
begin;

create or replace function public.asn_relay_push_recipient_mail(p_node text, p_message_id uuid)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_user uuid;
begin
  select m.person_user into v_user from relay.messages m where m.id = p_message_id and m.from_node = p_node;
  return jsonb_build_object('user', v_user);
end;
$function$;

create or replace function public.asn_relay_push_recipient_node(p_node text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_user uuid;
begin
  select n.owner_user into v_user from relay.nodes n where n.id = p_node and n.status = 'active';
  return jsonb_build_object('user', v_user);
end;
$function$;

revoke all on function public.asn_relay_push_recipient_mail(text, uuid) from public, anon, authenticated;
revoke all on function public.asn_relay_push_recipient_node(text) from public, anon, authenticated;
grant execute on function public.asn_relay_push_recipient_mail(text, uuid) to service_role;
grant execute on function public.asn_relay_push_recipient_node(text) to service_role;

commit;
