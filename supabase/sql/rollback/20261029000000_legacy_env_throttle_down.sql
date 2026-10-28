-- 退回 20261029000000_legacy_env_throttle.sql：asn_relay_set_legacy_env 換回 20261028230000_legacy_env.sql 的版本（每次呼叫都寫）。
-- 只換函式本體，不動欄位與資料；relay 函式不用跟著退（它只看回傳有沒有 error）。
begin;

create or replace function public.asn_relay_set_legacy_env(p_node text, p_names text[])
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_names text[];
begin
  select coalesce(array_agg(s.n order by s.n collate "C"), '{}'::text[]) into v_names
    from (
      select d.n from (
        select distinct u.n from unnest(coalesce(p_names, '{}'::text[])) as u(n)
          where u.n ~ '^IRORI_[A-Z0-9_]{1,64}$'
      ) d
      order by d.n collate "C"
      limit 64
    ) s;
  update relay.nodes set used_legacy_env = v_names, used_legacy_env_at = now()
    where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  return jsonb_build_object('ok', true, 'count', cardinality(v_names));
end;
$function$;

revoke all on function public.asn_relay_set_legacy_env(text, text[]) from public, anon, authenticated;
grant execute on function public.asn_relay_set_legacy_env(text, text[]) to service_role;

commit;
