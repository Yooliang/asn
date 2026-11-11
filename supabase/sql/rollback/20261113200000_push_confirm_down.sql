-- 回復 20261113200000_push_confirm.sql：push_targets 還原成 20261112700000 的版本（只接受 owner_mail／waiting），並移除 push_node_name。
-- 先確認沒有 confirm 推播在跑再回復（回復後 Edge 送 confirm 會得到 bad_request，不推、不影響其他功能）。
begin;

drop function if exists public.asn_relay_push_node_name(text);

create or replace function public.asn_relay_push_targets(p_user uuid, p_kind text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_out jsonb;
begin
  if p_kind is null or p_kind not in ('owner_mail', 'waiting') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if p_user is null then
    return jsonb_build_object('targets', '[]'::jsonb);
  end if;
  with due as (
    select t.node
      from relay.push_tokens t join relay.nodes n on n.id = t.node
     where n.owner_user = p_user and n.status = 'active' and n.platform = 'android'
       and t.updated_at > now() - interval '30 days'
       and not exists (select 1 from relay.asn_presence p where p.node = t.node and p.fg_at > now() - interval '3 minutes')
  ), sent as (
    update relay.push_tokens t set last_sent_at = now()
      from due
     where t.node = due.node and (t.last_sent_at is null or t.last_sent_at < now() - interval '60 seconds')
    returning t.node, t.token
  )
  select coalesce(jsonb_agg(jsonb_build_object('node', node, 'token', token) order by node), '[]'::jsonb) into v_out from sent;
  return jsonb_build_object('targets', v_out);
end;
$function$;

revoke all on function public.asn_relay_push_targets(uuid, text) from public, anon, authenticated;
grant execute on function public.asn_relay_push_targets(uuid, text) to service_role;

commit;
