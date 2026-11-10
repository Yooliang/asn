-- 回復 20261112700000_presence_foreground.sql：push_targets 換回只看 updated_at 的原文（逐字取自 20261109100000_push_tokens.sql），
--   asn_relay_asn_presence_set 換回 5 參數原版（取自 20261021020000_asn_presence.sql），再 drop fg_at 欄位。
-- 部署順序：先把 Edge（relay）換回舊版（舊版不傳 p_foreground），再跑這支。
begin;
drop function if exists public.asn_relay_asn_presence_set(text, text, text, text, text, boolean);
create or replace function public.asn_relay_asn_presence_set(p_node text, p_window text, p_version text, p_status text, p_psm text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_window text := btrim(p_window);
  v_psm text := nullif(btrim(coalesce(p_psm, '')), '');
begin
  if v_window is null or char_length(v_window) not between 1 and 40 or v_window ~ '[[:cntrl:]]' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active') then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_status = 'offline' then
    delete from relay.asn_presence where node = p_node and window_name = v_window;
    return jsonb_build_object('ok', true);
  end if;
  if p_status is null or p_status not in ('online', 'away', 'busy')
     or p_version is null or p_version !~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,16})?$'
     or (v_psm is not null and (char_length(v_psm) > 80 or v_psm ~ '[[:cntrl:]]')) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and window_name = v_window)
     and (select count(*) from relay.asn_presence where node = p_node) >= 20 then
    return jsonb_build_object('error', 'too_many');
  end if;
  insert into relay.asn_presence (node, window_name, version, status, psm, updated_at)
    values (p_node, v_window, p_version, p_status, v_psm, now())
  on conflict (node, window_name) do update
    set version = excluded.version, status = excluded.status, psm = excluded.psm, updated_at = excluded.updated_at;
  return jsonb_build_object('ok', true);
end;
$function$;
revoke all on function public.asn_relay_asn_presence_set(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_asn_presence_set(text, text, text, text, text) to service_role;

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
       and not exists (select 1 from relay.asn_presence p where p.node = t.node and p.updated_at > now() - interval '3 minutes')
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
alter table relay.asn_presence drop column if exists fg_at;
commit;
