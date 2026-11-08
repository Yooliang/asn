-- 通知集中 PR-D（#848）：橋自己寄的通知改由後台以「ASN 通知」寄出，kind＝notice:bridge。
-- 新函式 public.asn_relay_send_bridge_notice(p_node, p_reply_to, p_body)：
--  - 只能回覆「寄給這個節點、24 小時內」的那封信；收件人一律由後台從那封信取（原寄件節點與視窗），橋不能指定。
--  - 原信本身是通知（kind 開頭 notice:）或寄件人是「ASN 通知」就不回，避免兩台橋互相回成迴圈。
--  - 只回同帳號：原寄件節點的擁有者必須等於 p_node 的擁有者（兩者都不是空、而且都通過 asn_user_owns_node）。
--    跨帳號回 {error: cross_account}，橋照舊用「<節點>-收發室」寄（內文由橋決定，不能讓任何節點用官方名義寄給別的帳號）。
--  - 內文：清掉控制字元（保留換行與 tab），長度上限比照 asn_relay_send_core；第一行由後台加上「<設備顯示名>：」。
--  - 限流（同一個 advisory lock 內原子判斷）：同一封原信最多回 3 封；同一節點每小時最多 120 封。
--  - 只授權 service_role（Edge 的 relay?action=bridge_notice，節點金鑰）。
-- 依賴：20261111100000_notice_center.sql（kind 欄位）。要和它同一版部署，也要等 PR-B 那一版的橋普及。
-- 回復：drop function public.asn_relay_send_bridge_notice(text, uuid, text);（橋收到 404 會自己退回舊的寄法）
begin;

create or replace function public.asn_relay_send_bridge_notice(p_node text, p_reply_to uuid, p_body text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  r relay.messages%rowtype;
  v_owner uuid;
  v_from_owner uuid;
  v_machine text;
  v_name text;
  v_text text;
  v_body text;
  v_n int;
  v_res jsonb;
  v_id uuid;
  v_topics jsonb := '[]'::jsonb;
  v_kind constant text := 'notice:bridge';
  v_agent constant text := 'ASN 通知';
  v_per_mail constant int := 3;
  v_per_hour constant int := 120;
begin
  if p_node is null or p_reply_to is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 控制字元一律清掉（換行與 tab 保留，\r 一起清）；長度規則同 asn_relay_send_core，留 64 字給第一行的設備名
  v_text := regexp_replace(coalesce(p_body, ''), '[\x01-\x08\x0b-\x1f\x7f]', '', 'g');
  if char_length(btrim(v_text)) < 1 or char_length(v_text) > 19936 then
    return jsonb_build_object('error', 'bad_body');
  end if;
  select owner_user, coalesce(machine, name) into v_owner, v_machine from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  -- 同一個節點的橋通知全部排隊判斷：每封原信的次數與每小時的次數都在這個鎖裡數
  perform pg_advisory_xact_lock(hashtext('notice:' || p_node || ':' || v_kind));
  select * into r from relay.messages
    where id = p_reply_to and to_node = p_node and created_at > now() - interval '24 hours';
  if not found or r.from_node is null then
    return jsonb_build_object('error', 'no_origin');
  end if;
  if coalesce(r.kind, '') like 'notice:%' or r.from_agent = v_agent then
    return jsonb_build_object('error', 'is_notice');
  end if;
  select owner_user into v_from_owner from relay.nodes where id = r.from_node;
  if v_owner is null or v_from_owner is null or v_from_owner <> v_owner
     or not public.asn_user_owns_node(v_owner, p_node) or not public.asn_user_owns_node(v_owner, r.from_node) then
    return jsonb_build_object('error', 'cross_account');
  end if;
  select count(distinct coalesce(fanout_id, id)) into v_n from relay.messages
    where from_node = p_node and kind = v_kind and reply_to = p_reply_to;
  if v_n >= v_per_mail then
    return jsonb_build_object('ok', true, 'notify', 'per_mail_limit', 'bell_topics', '[]'::jsonb);
  end if;
  select count(distinct coalesce(fanout_id, id)) into v_n from relay.messages
    where from_node = p_node and kind = v_kind and created_at > now() - interval '1 hour';
  if v_n >= v_per_hour then
    return jsonb_build_object('ok', true, 'notify', 'rate_limited', 'bell_topics', '[]'::jsonb);
  end if;
  v_name := coalesce(nullif(btrim(left(regexp_replace(coalesce(v_machine, ''), '[[:cntrl:]]', ' ', 'g'), 40)), ''), '未命名設備');
  v_body := v_name || '：' || v_text;
  v_res := public.asn_relay_send(p_node, v_agent, r.from_node, nullif(r.from_agent, ''), v_body, p_reply_to, false, null, false);
  if v_res is null or v_res ? 'error' then
    return jsonb_build_object('ok', true, 'notify', 'failed', 'bell_topics', '[]'::jsonb, 'send', v_res);
  end if;
  -- 同一次寄出的每一列（含扇出）都標上種類；寄信結果沒有 id 就整筆回滾，不留沒有 kind 的通知
  v_id := nullif(coalesce(v_res ->> 'id', v_res ->> 'fanout_id'), '')::uuid;
  if v_id is null then
    raise exception 'asn_relay_send_bridge_notice: send result has no id';
  end if;
  update relay.messages set kind = v_kind
    where from_node = p_node and kind is null and (id = v_id or fanout_id = v_id);
  v_topics := case
    when jsonb_typeof(v_res -> 'bell_topics') = 'array' then v_res -> 'bell_topics'
    when jsonb_typeof(v_res -> 'bell_topic') = 'string' then jsonb_build_array(v_res -> 'bell_topic')
    else '[]'::jsonb end;
  return jsonb_build_object('ok', true, 'notify', 'sent', 'id', v_id, 'bell_topics', v_topics, 'fanout', v_res -> 'fanout');
end;
$function$;
revoke all on function public.asn_relay_send_bridge_notice(text, uuid, text) from public, anon, authenticated;
grant execute on function public.asn_relay_send_bridge_notice(text, uuid, text) to service_role;

commit;
