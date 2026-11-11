-- 手機推播新增一種通知「需要你確認」（confirm）：電腦在等本人用手機決定的請求（權限／外部訊息框、終端送字或代答）。
-- 一、asn_relay_push_targets 的 p_kind 多接受 'confirm'；其餘與 20261112700000 逐字相同。
--     confirm 的「前景不推」規則與 owner_mail／waiting 完全一致：手機 3 分鐘內有前景回報就不推（App 開著本來就會看到請求清單），
--     60 秒每台一則的名額也是同一個（last_sent_at 不分種類）。
-- 二、asn_relay_push_node_name(p_node)：只回節點顯示名，給通知文字用（只給 service_role）。
-- 建立請求的函式不改：重複的畫面會回 busy 而不會建第二列，所以「建立成功」就等於「新增了一列」。
-- 回復：supabase/sql/rollback/20261113200000_push_confirm_down.sql
begin;

create or replace function public.asn_relay_push_targets(p_user uuid, p_kind text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_out jsonb;
begin
  if p_kind is null or p_kind not in ('owner_mail', 'waiting', 'confirm') then
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

create or replace function public.asn_relay_push_node_name(p_node text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_name text;
begin
  select n.name into v_name from relay.nodes n where n.id = p_node and n.status = 'active';
  return jsonb_build_object('name', v_name);
end;
$function$;

revoke all on function public.asn_relay_push_node_name(text) from public, anon, authenticated;
grant execute on function public.asn_relay_push_node_name(text) to service_role;

commit;
