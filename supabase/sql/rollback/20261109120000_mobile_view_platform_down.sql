-- 退回 20261109120000_mobile_view_platform.sql：拿掉平台登記與 mobile_off 原因，函式回到上一版。
-- 已用 mobile_off 結束的紀錄改記為 rejected（結束的紀錄本來就一天後刪除）。
begin;

update relay.term_views set end_reason = 'rejected' where end_reason = 'mobile_off';
alter table relay.term_views drop constraint if exists term_views_reason_check;
alter table relay.term_views add constraint term_views_reason_check check (end_reason is null or end_reason = any (array['expired','viewer_ended','target_ended','rejected','viewer_gone','failed']));

drop function if exists public.asn_relay_device_key_publish(text, text);
drop function if exists public.asn_relay_device_key_publish(text, text, text);
create or replace function public.asn_relay_device_key_publish(p_node text, p_sign_pub text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_t uuid;
begin
  select tenant_id into v_t from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_sign_pub is null or p_sign_pub !~ '^[A-Za-z0-9_-]{43}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  insert into relay.device_keys (node, tenant_id, sign_pub) values (p_node, v_t, p_sign_pub)
    on conflict (node) do update set sign_pub = excluded.sign_pub, updated_at = now()
    where relay.device_keys.sign_pub is distinct from excluded.sign_pub;
  return jsonb_build_object('ok', true);
end;
$function$;

create or replace function public.asn_relay_term_view_pending(p_node text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_req jsonb;
  v_act jsonb;
begin
  perform public.asn_relay_term_view_expire();
  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'scope', v.scope, 'from_node', v.from_node, 'from_name', n.name, 'from_pub', k.sign_pub, 'window_name', v.window_name, 'topic', v.topic,
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

create or replace function public.asn_relay_term_view_stop(p_node text, p_id uuid, p_reason text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_n int;
begin
  if p_id is null or p_reason is null or p_reason not in ('target_ended', 'rejected', 'viewer_gone', 'failed') then
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

revoke all on function public.asn_relay_device_key_publish(text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_device_key_publish(text, text) to service_role;

alter table relay.device_keys drop constraint if exists device_keys_platform_check;
alter table relay.device_keys drop column if exists platform;

commit;
