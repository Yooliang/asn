-- 退回 20261123120000_login_alert_device_name.sql：asn_relay_login_alert 換回 20261111100000_notice_center.sql 的本體（設備名用 ASN 帶來的電腦名稱）。不刪任何資料；已寄出的通知信留著。
begin;

create or replace function public.asn_relay_login_alert(p_node text, p_computer text, p_last_at timestamptz, p_email text default null, p_timeouts integer default 0)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_computer text := btrim(coalesce(p_computer, ''));
  v_body text;
  v_res jsonb;
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
  v_body := v_computer || '：Claude 登入失效' || E'\n'
    || '最後一次錯誤 ' || to_char(p_last_at at time zone 'Asia/Taipei', 'HH24:MI')
    || case when p_email is not null then '，帳號 ' || p_email else '' end || '。'
    || case when p_timeouts > 0 then '這段時間轉交逾時 ' || p_timeouts || ' 次。' else '' end;
  -- 限流（同一節點每小時 3 封）改由 asn_relay_send_notice 依「節點＋種類」計算；本函式的回傳維持舊形狀
  v_res := public.asn_relay_send_notice(p_node, 'login', v_body, 3, interval '1 hour');
  if v_res is null then
    return jsonb_build_object('error', 'send_failed');
  end if;
  if v_res ->> 'notify' = 'rate_limited' then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  if v_res ? 'error' then
    return v_res;
  end if;
  return coalesce(v_res -> 'send', jsonb_build_object('error', 'send_failed'));
end;
$function$;

revoke all on function public.asn_relay_login_alert(text, text, timestamptz, text, integer) from public, anon, authenticated;
grant execute on function public.asn_relay_login_alert(text, text, timestamptz, text, integer) to service_role;

commit;
