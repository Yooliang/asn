-- 【獨立區塊】登入失效通知：橋接程式寄一封通知信給「這個節點自己的擁有者」（0.1.113，後台；設計 docs/design/LOGIN-EXPIRED-ALERT.md 第二節末）。
-- 與 20261031100000_acct_login_flags.sql 分開，審查可各自看、各自回復。
--
-- 為什麼需要新函式：既有 asn_relay_send 能寄 u:<人代號>，但人代號要由寄件端帶，橋接程式不知道擁有者是誰，也不該由用戶端指定收件人。
-- 這支由後台依節點查擁有者（relay.nodes.owner_user），收件人、寄件名、內文格式全部在這裡決定，用戶端只能給四個固定欄位。
-- 最後仍呼叫既有的 asn_relay_send（扇出給擁有者各在線的 ASN 視窗、沒有在線就留一列等人打開），所以租戶／擁有者核對沿用那一支：
--   asn_relay_send 只認「寄件節點所屬租戶的擁有者」的人代號；節點擁有者與租戶擁有者不同人時回 unknown_to_node，這支原樣回傳（不寄）。
-- 限制：
--  1. 收件人只能是節點自己的擁有者（p_node 取自節點金鑰，由 Edge 帶入；沒有收件人參數）。節點必須 active 且 asn_user_owns_node 成立，否則 not_claimed。
--  2. 只收固定欄位：電腦名（1～40 字、無控制字元）、最後錯誤時間（不可晚於現在 10 分鐘、不可早於 24 小時前）、帳號 email（選填，須通過 asn_relay_acct_email_ok）、
--     轉交逾時次數（0～999）。錯誤原文沒有欄位可帶。內文由這裡套固定句型組出，長度必然很短（< 300 字）。
--  3. 限流：同一節點每小時最多 3 封（以寄件名「登入通知收發室」計；以 advisory lock 串行避免並發穿透），超過回 rate_limited、不寄。
--     另外還有 asn_relay_send 本身每分鐘 30 則的上限。
--  4. 不開放給 public／anon／authenticated，只給 service_role；security definer、search_path 空。
-- 沒有改資料表、沒有改既有函式。
-- 部署順序：本 migration → relay（Edge Function，新動作 acct_login_alert）→ 電腦端。提早上任何一步都不會壞（舊 Edge 沒有這個動作，電腦端會得到 404，不影響其他功能）。
--   部署：npx supabase db query --linked -f supabase/migrations/20261031110000_acct_login_alert_notify.sql（部署前在群組說）。
-- 回復：supabase/sql/rollback/20261031110000_acct_login_alert_notify_down.sql（drop 這一支函式）。已寄出的信不受影響。
begin;

create or replace function public.asn_relay_login_alert(p_node text, p_computer text, p_last_at timestamptz, p_email text default null, p_timeouts integer default 0)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_alias text;
  v_computer text := btrim(coalesce(p_computer, ''));
  v_body text;
  v_recent int;
  v_agent constant text := '登入通知收發室';
begin
  select owner_user into v_owner from relay.nodes where id = p_node and status = 'active';
  if v_owner is null or not public.asn_user_owns_node(v_owner, p_node) then
    return jsonb_build_object('error', 'not_claimed');
  end if;
  if char_length(v_computer) < 1 or char_length(v_computer) > 40 or v_computer ~ '[[:cntrl:]]'
     or p_last_at is null or p_last_at > now() + interval '10 minutes' or p_last_at < now() - interval '24 hours'
     or (p_email is not null and not public.asn_relay_acct_email_ok(p_email))
     or p_timeouts is null or p_timeouts < 0 or p_timeouts > 999 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  perform pg_advisory_xact_lock(hashtext('login_alert:' || p_node));
  select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
    where from_node = p_node and from_agent = v_agent and created_at > now() - interval '1 hour';
  if v_recent >= 3 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  v_alias := public.asn_person_alias(v_owner);
  v_body := v_computer || '的 Claude 登入失效（最後一次錯誤 ' || to_char(p_last_at at time zone 'Asia/Taipei', 'HH24:MI')
    || case when p_email is not null then '，帳號 ' || p_email else '' end || '）。'
    || case when p_timeouts > 0 then '這段時間轉交逾時 ' || p_timeouts || ' 次。' else '' end;
  return public.asn_relay_send(p_node, v_agent, v_alias, null, v_body, null, false, null, false);
end;
$function$;

revoke all on function public.asn_relay_login_alert(text, text, timestamptz, text, integer) from public, anon, authenticated;
grant execute on function public.asn_relay_login_alert(text, text, timestamptz, text, integer) to service_role;

commit;
