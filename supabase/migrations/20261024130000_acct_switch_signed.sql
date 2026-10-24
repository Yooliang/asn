-- 手機版替各電腦切換 Claude 帳號（#227）：asn_relay_acct_list／asn_relay_acct_switch 原本只准 role = 'owner' 的節點。
-- 手機是 role = 'member'，所以多認一條（與 20261022070000_launch_signed.sql 同一套做法）：
-- 呼叫端帶了本人簽章（Edge Function 驗過登入憑證，把使用者 id 傳進來），而且「這個節點與它的租戶都是這個人的」
-- （asn_user_owns_node）就視同擁有者。沒帶簽章＝與以前完全相同，舊的 Edge Function 呼叫四個參數的版本也不會壞（新參數有預設值）。
-- 對方電腦那一關不變：預設仍要對方使用者在本機按「同意」才會真的換帳號（或對方設定信任自己的設備）。
-- acct_switch_status 只看「自己送出的指令」（requested_by = p_actor），不需要改。
-- 不改任何資料表。先不套用：部署順序為 migration → relay 函式 → 發新版 ASN（手機）。
-- 回復：換回 20261023160000_acct_report_vendors.sql 與 20261021040000_asn_account_switch.sql 的定義（先 drop 五參數版本）。
begin;

drop function if exists public.asn_relay_acct_list(text, text);
drop function if exists public.asn_relay_acct_switch(text, text, text, text);

create or replace function public.asn_relay_acct_list(p_actor text, p_node text, p_signed_user uuid default null::uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_t uuid;
  v_a jsonb;
  v_at timestamptz;
  v_online boolean;
begin
  select tenant_id into v_t from relay.nodes
    where id = p_actor and status = 'active'
      and (role = 'owner' or public.asn_user_owns_node(p_signed_user, p_actor));
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active' and tenant_id is not distinct from v_t) then
    return jsonb_build_object('error', 'not_found');
  end if;
  select accounts, updated_at into v_a, v_at from relay.asn_accounts where node = p_node;
  select exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - interval '3 minutes') into v_online;
  return jsonb_build_object('node', p_node, 'accounts', coalesce(v_a, '[]'::jsonb), 'reported_at', v_at, 'asn_online', v_online);
end;
$function$;

create or replace function public.asn_relay_acct_switch(p_actor text, p_node text, p_vendor text, p_email text, p_signed_user uuid default null::uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_t uuid;
  v_topic text;
  v_id uuid;
begin
  select tenant_id into v_t from relay.nodes
    where id = p_actor and status = 'active'
      and (role = 'owner' or public.asn_user_owns_node(p_signed_user, p_actor));
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select bell_topic into v_topic from relay.nodes where id = p_node and status = 'active' and tenant_id is not distinct from v_t;
  if v_topic is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_vendor is distinct from 'claude' then
    return jsonb_build_object('error', 'bad_vendor');
  end if;
  if not public.asn_relay_acct_email_ok(p_email) then
    return jsonb_build_object('error', 'bad_email');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - interval '3 minutes') then
    return jsonb_build_object('error', 'asn_offline');
  end if;
  if not exists (select 1 from relay.asn_accounts a, jsonb_array_elements(a.accounts) e where a.node = p_node and e->>'vendor' = 'claude' and e->>'email' = p_email) then
    return jsonb_build_object('error', 'unknown_account');
  end if;
  perform public.asn_relay_acct_expire();
  if exists (select 1 from relay.account_switches where node = p_node and status in ('pending', 'taken')) then
    return jsonb_build_object('error', 'busy');
  end if;
  if (select count(*) from relay.account_switches where node = p_node and created_at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.account_switches (tenant_id, requested_by, node, vendor, email)
    values (v_t, p_actor, p_node, p_vendor, p_email) returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

-- 舊名（irori_ 開頭）的轉接函式：被 drop 掉的兩個底層函式換了簽章，轉接要重建才會指到新版
create or replace function public.irori_relay_acct_list(p_actor text, p_node text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_acct_list(p_actor, p_node);
$function$;

create or replace function public.irori_relay_acct_switch(p_actor text, p_node text, p_vendor text, p_email text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_acct_switch(p_actor, p_node, p_vendor, p_email);
$function$;

revoke all on function public.asn_relay_acct_list(text, text, uuid) from public, anon, authenticated;
revoke all on function public.asn_relay_acct_switch(text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.irori_relay_acct_list(text, text) from public, anon, authenticated;
revoke all on function public.irori_relay_acct_switch(text, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_list(text, text, uuid) to service_role;
grant execute on function public.asn_relay_acct_switch(text, text, text, text, uuid) to service_role;
grant execute on function public.irori_relay_acct_list(text, text) to service_role;
grant execute on function public.irori_relay_acct_switch(text, text, text, text) to service_role;

commit;
