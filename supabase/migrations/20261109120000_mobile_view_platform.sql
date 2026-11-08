-- 允許移動設備查看終端（手機看電腦的終端 PR⑤）：後台登記每把設備公鑰屬於電腦還是手機，被看的那台依此決定要不要接受。
-- 設計（asn真 定）：
--   * 平台記在 relay.device_keys，和設備公鑰同一列：同一把公鑰「第一次登記平台」時寫入，之後不能改（要換平台就得換新金鑰，被看的那台會走首次提示）。
--     null＝舊資料（還沒登記平台），一律當電腦。只收 desktop／android。
--   * 公鑰上傳新增選填的 p_platform。舊版用戶端不帶，照常能上傳（兩個參數的版本轉呼叫三個參數的版本，和 term_view_start 同一個做法，避免同名多載歧義）。
--   * 被看的那台領請求（term_view_pending）時多拿到 from_platform＝看的那台的公鑰登記的平台（null 當 desktop）。
--     「允許移動設備查看終端」這個開關只存在被看的那台本機，後台不存、發起階段不擋：被看的那台領到請求時依本機設定接受或拒絕。
--   * 被看的那台拒絕移動設備時用新的固定原因 mobile_off 回報（term_view_stop），看的那台顯示一句清楚的話。
-- 先不用：舊版不帶 platform、不認得 from_platform 與 mobile_off，行為不變。
-- 回復：supabase/sql/rollback/20261109120000_mobile_view_platform_down.sql。
begin;

alter table relay.device_keys add column if not exists platform text;
alter table relay.device_keys drop constraint if exists device_keys_platform_check;
alter table relay.device_keys add constraint device_keys_platform_check check (platform is null or platform = any (array['desktop', 'android']));

-- 上傳自己的設備公鑰（節點金鑰），新版：多帶 platform。重裝就是新金鑰：蓋掉公鑰，平台跟著新的那次登記
create or replace function public.asn_relay_device_key_publish(p_node text, p_sign_pub text, p_platform text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_t uuid;
begin
  select tenant_id into v_t from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_sign_pub is null or p_sign_pub !~ '^[A-Za-z0-9_-]{43}$'
     or (p_platform is not null and p_platform not in ('desktop', 'android')) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 公鑰沒變：平台只有「原本還沒登記」時才寫入，已登記的不能改。公鑰換了＝新金鑰，平台重新登記
  insert into relay.device_keys (node, tenant_id, sign_pub, platform) values (p_node, v_t, p_sign_pub, p_platform)
    on conflict (node) do update set
      platform = case when relay.device_keys.sign_pub is distinct from excluded.sign_pub then excluded.platform
                      else coalesce(relay.device_keys.platform, excluded.platform) end,
      sign_pub = excluded.sign_pub,
      updated_at = now()
    where relay.device_keys.sign_pub is distinct from excluded.sign_pub
       or (relay.device_keys.platform is null and excluded.platform is not null);
  return jsonb_build_object('ok', true);
end;
$function$;

-- 舊版（兩個參數，線上 Edge 與舊用戶端在用）：不帶平台，轉呼叫新版
create or replace function public.asn_relay_device_key_publish(p_node text, p_sign_pub text)
 returns jsonb language sql security definer set search_path to ''
as $function$
  select public.asn_relay_device_key_publish(p_node, p_sign_pub, null::text);
$function$;

-- T 領取（節點金鑰）：多帶 from_platform＝看的那台的公鑰登記的平台（null 當 desktop）
create or replace function public.asn_relay_term_view_pending(p_node text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_req jsonb;
  v_act jsonb;
begin
  perform public.asn_relay_term_view_expire();
  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'scope', v.scope, 'from_node', v.from_node, 'from_name', n.name, 'from_pub', k.sign_pub, 'from_platform', coalesce(k.platform, 'desktop'),
      'window_name', v.window_name, 'topic', v.topic,
      'd_eph_pub', v.d_eph_pub, 'd_sig', v.d_sig, 'expires_s', extract(epoch from v.expires_at)::bigint) order by v.created_at), '[]'::jsonb)
    into v_req
    from relay.term_views v join relay.nodes n on n.id = v.from_node join relay.device_keys k on k.node = v.from_node
    where v.to_node = p_node and v.status = 'requested';
  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'scope', v.scope, 'status', v.status, 'viewer_stale', v.viewer_seen_at < now() - interval '90 seconds')), '[]'::jsonb)
    into v_act
    from relay.term_views v
    where v.to_node = p_node and v.status in ('accepted', 'watching', 'paused');
  return jsonb_build_object('requests', v_req, 'active', v_act);
end;
$function$;

-- T 結束或拒絕（節點金鑰）：原因多一個 mobile_off（這台不允許移動設備查看）
alter table relay.term_views drop constraint if exists term_views_reason_check;
alter table relay.term_views add constraint term_views_reason_check check (end_reason is null or end_reason = any (array['expired','viewer_ended','target_ended','rejected','viewer_gone','failed','mobile_off']));

create or replace function public.asn_relay_term_view_stop(p_node text, p_id uuid, p_reason text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_n int;
begin
  if p_id is null or p_reason is null or p_reason not in ('target_ended', 'rejected', 'viewer_gone', 'failed', 'mobile_off') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.term_views
    set status = 'ended', end_reason = p_reason, ended_at = now(), topic = null, d_eph_pub = null, d_sig = null, t_eph_pub = null, t_sig = null
    where id = p_id and to_node = p_node and status <> 'ended';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.asn_relay_device_key_publish(text, text, text) from public, anon, authenticated;
revoke all on function public.asn_relay_device_key_publish(text, text) from public, anon, authenticated;
revoke all on function public.asn_relay_term_view_pending(text) from public, anon, authenticated;
revoke all on function public.asn_relay_term_view_stop(text, uuid, text) from public, anon, authenticated;
grant execute on function public.asn_relay_device_key_publish(text, text, text) to service_role;
grant execute on function public.asn_relay_device_key_publish(text, text) to service_role;
grant execute on function public.asn_relay_term_view_pending(text) to service_role;
grant execute on function public.asn_relay_term_view_stop(text, uuid, text) to service_role;

commit;
