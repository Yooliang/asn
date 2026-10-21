-- 2026-10-21：搬家前的舊租戶 owner_user 指向舊後端的帳號（新後端 auth.users 沒有這個人），
-- 導致 asn_admin_adopt_tenant 回 tenant_owned、小良哥登入後認領不到 H／w02 等節點。
-- 改成：原主人不存在於 auth.users 時視為沒有主人。
begin;

create or replace function public.asn_admin_adopt_tenant(p_email text, p_serial integer default 1)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_user uuid;
  v_t relay.tenants%rowtype;
  v_own relay.tenants%rowtype;
  v_cnt int;
begin
  select id into v_user from auth.users where lower(email) = lower(btrim(p_email)) order by created_at limit 1;
  if v_user is null then
    return jsonb_build_object('error', 'user_not_found');
  end if;
  select * into v_t from relay.tenants where serial = p_serial for update;
  if not found then
    return jsonb_build_object('error', 'tenant_not_found');
  end if;
  -- 舊後端搬來的租戶，owner_user 可能指向新後端 auth.users 裡不存在的帳號：當成沒有主人
  if v_t.owner_user is not null and v_t.owner_user <> v_user
     and exists (select 1 from auth.users where id = v_t.owner_user) then
    return jsonb_build_object('error', 'tenant_owned');
  end if;
  select * into v_own from relay.tenants where owner_user = v_user and id <> v_t.id;
  if found then
    if exists (select 1 from relay.nodes where tenant_id = v_own.id) then
      return jsonb_build_object('error', 'user_has_nodes');
    end if;
    delete from relay.tenants where id = v_own.id;
  end if;
  update relay.tenants set owner_user = v_user where id = v_t.id;
  update relay.nodes set owner_user = v_user, created_via = coalesce(created_via, 'claim-existing')
    where tenant_id = v_t.id and owner_user is null and status = 'active';
  get diagnostics v_cnt = row_count;
  insert into relay.account_events (user_id, event, detail)
    values (v_user, 'tenant_adopted', jsonb_build_object('serial', v_t.serial, 'nodes', v_cnt));
  return jsonb_build_object('ok', true, 'tenant_serial', v_t.serial, 'nodes_claimed', v_cnt, 'user', v_user);
end;
$function$;
revoke all on function public.asn_admin_adopt_tenant(text, integer) from public, anon, authenticated;
grant execute on function public.asn_admin_adopt_tenant(text, integer) to service_role;

commit;
