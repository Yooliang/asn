-- 設備金鑰的通知（#597 別台看畫面，0.2.8 改版）：TOFU 第一次記住對方、或對方的公鑰換了，都寄一封固定文字的信給本人。
-- 設計（asn真 定）：
--   * 由發現的那台（節點金鑰）呼叫；只能指定「哪一台、哪一種、指紋」，收件人和文字都在後台決定。
--   * first＝第一次記住對方（萬一第一次就是後台塞的假公鑰，本人也看得到）；changed＝公鑰換了、已拒絕連線。
--   * 限流：同一對（這台、對方）同一種一天只寄一次；每個節點每小時最多 30 封（和看畫面的通知同一個上限計法）。
--   * 對方要是同一個本人的另一台；不是就不寄（skipped），也不透露原因。
--   * 指紋只收 16～32 個小寫十六進位字元，寫進信裡讓本人比對；不收任何別的內容。
-- 先不用：舊版不會呼叫。
-- 回復：drop 函式 asn_relay_device_key_alert 與 relay.device_key_alerts。
begin;

create table if not exists relay.device_key_alerts (
  node text not null,
  peer text not null,
  kind text not null,
  sent_at timestamptz not null default now(),
  constraint device_key_alerts_pkey primary key (node, peer, kind),
  constraint device_key_alerts_kind_check check (kind = any (array['first', 'changed'])),
  constraint device_key_alerts_node_fkey foreign key (node) references relay.nodes(id) on delete cascade,
  constraint device_key_alerts_peer_fkey foreign key (peer) references relay.nodes(id) on delete cascade
);
alter table relay.device_key_alerts enable row level security;
revoke all on relay.device_key_alerts from public, anon, authenticated;

create or replace function public.asn_relay_device_key_alert(p_node text, p_peer text, p_kind text, p_fp text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_owner uuid;
  v_me text;
  v_peer text;
  v_body text;
  v_recent int;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_agent constant text := '看畫面收發室';
begin
  if p_peer is null or p_peer = p_node or p_kind is null or p_kind not in ('first', 'changed')
     or p_fp is null or p_fp !~ '^[0-9a-f]{16,32}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_me
    from relay.nodes where id = p_node and status = 'active';
  if not found or v_owner is null or not public.asn_user_owns_node(v_owner, p_node) then
    return jsonb_build_object('ok', true, 'notify', 'skipped', 'bell_topics', '[]'::jsonb);
  end if;
  -- 對方要是同一個本人的另一台
  if not public.asn_user_owns_node(v_owner, p_peer) then
    return jsonb_build_object('ok', true, 'notify', 'skipped', 'bell_topics', '[]'::jsonb);
  end if;
  select left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_peer from relay.nodes where id = p_peer;
  perform pg_advisory_xact_lock(hashtext('device_key_alert:' || p_node));
  delete from relay.device_key_alerts where sent_at < now() - interval '2 days';
  if exists (select 1 from relay.device_key_alerts where node = p_node and peer = p_peer and kind = p_kind and sent_at > now() - interval '1 day') then
    return jsonb_build_object('ok', true, 'notify', 'sent', 'bell_topics', '[]'::jsonb);
  end if;
  select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
    where from_node = p_node and from_agent = v_agent and created_at > now() - interval '1 hour';
  if v_recent >= 30 then
    return jsonb_build_object('ok', true, 'notify', 'rate_limited', 'bell_topics', '[]'::jsonb);
  end if;
  if p_kind = 'first' then
    v_body := '「' || coalesce(v_peer, '另一台電腦') || '」第一次連到這台（' || v_me || '），已記住它的設備金鑰（指紋 ' || left(p_fp, 16)
      || '）。如果不是你，請到這台的設定頁「認得的電腦」按忘記，並檢查帳號。';
  else
    v_body := '「' || coalesce(v_peer, '另一台電腦') || '」的設備金鑰變了（新指紋 ' || left(p_fp, 16) || '），這台（' || v_me
      || '）已拒絕連線。如果是你重裝了那台，請到這台的設定頁「認得的電腦」按忘記再連一次；不是的話請不要按，並檢查帳號。';
  end if;
  v_res := public.asn_relay_send(p_node, v_agent, public.asn_person_alias(v_owner), null, v_body, null, false, null, false);
  if v_res is null or v_res ? 'error' then
    return jsonb_build_object('ok', true, 'notify', 'failed', 'bell_topics', '[]'::jsonb);
  end if;
  insert into relay.device_key_alerts (node, peer, kind) values (p_node, p_peer, p_kind)
    on conflict (node, peer, kind) do update set sent_at = now();
  v_topics := case
    when jsonb_typeof(v_res->'bell_topics') = 'array' then v_res->'bell_topics'
    when jsonb_typeof(v_res->'bell_topic') = 'string' then jsonb_build_array(v_res->'bell_topic')
    else '[]'::jsonb end;
  return jsonb_build_object('ok', true, 'notify', 'sent', 'bell_topics', v_topics);
end;
$function$;

revoke all on function public.asn_relay_device_key_alert(text, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_device_key_alert(text, text, text, text) to service_role;

commit;
