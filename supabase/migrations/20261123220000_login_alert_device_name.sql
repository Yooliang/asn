-- 登入失效通知的設備名改用後台記的名字（#1881，#1860 E；設備名只有一份，#1803、#1819）。
--   原本：標題寫的是 ASN 回報的電腦主機名稱（p_computer），設備頁改過名的設備，通知還是寫主機名稱；同一個通知列表裡，其他通知用後台的名字，兩種通知兩種名字。
--   現在：只換一支函式 asn_relay_login_alert，名字由後台依節點查（relay.nodes.name，和其餘通知、設備頁同一份）；
--   p_computer 保留在簽章裡（舊版 ASN 還會帶），但不再採用、也不再檢查；後台名字空白時寫「電腦（代號末 4 碼）」。
--   其餘（擁有者檢查、時間／email／次數檢查、限流、寄信）與 20261111100000_notice_center.sql 版逐字相同。簽章與權限不變。
--   回復：sql/rollback/20261123220000_login_alert_device_name_down.sql 換回 notice_center 版本體。
begin;

create or replace function public.asn_relay_login_alert(p_node text, p_computer text, p_last_at timestamptz, p_email text default null, p_timeouts integer default 0)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_computer text;
  v_body text;
  v_res jsonb;
begin
  -- 設備名只有一份：後台記的名字（relay.nodes.name，和設備頁同一份）。p_computer 是舊版 ASN 帶的電腦主機名稱，不再採用（#1881）
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_computer
    from relay.nodes where id = p_node and status = 'active';
  if v_owner is null or not public.asn_user_owns_node(v_owner, p_node) then
    return jsonb_build_object('error', 'not_claimed');
  end if;
  -- 後台名字空白時寫辨認線索「電腦（代號末 4 碼）」，和畫面上設備名空白時同一種寫法
  v_computer := coalesce(nullif(v_computer, ''), '電腦（' || upper(right(regexp_replace(p_node, '[^0-9A-Za-z]', '', 'g'), 4)) || '）');
  if p_last_at is null or p_last_at > now() + interval '10 minutes' or p_last_at < now() - interval '24 hours'
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
