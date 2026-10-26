-- Grok 帳號可以回報與遠端切換（做法與 Claude 相同，登入檔整份在對方電腦上換）。
-- 兩支函式各改一處（以 20261023160000 的回報函式、20261026100000 的切換函式為基礎，其餘逐字不變）：
--   1. asn_relay_acct_report：vendor 可以是 claude、codex 或 grok；仍只留 vendor／email／plan／current 四欄，最多 20 筆。
--   2. asn_relay_acct_switch：vendor 可以是 claude 或 grok；「email 在對方回報的清單裡」改成比對同一個廠商那幾筆（不能拿別家的帳號當目標）。
-- 切換指令表（relay.account_switches.vendor）沒有限制清單，不用改。舊版桌面只送 claude 也照舊通過；
-- 舊版桌面取走 grok 指令時會因為「目前只支援切換 Claude 帳號」直接回報失敗（不會誤切）。
-- 部署順序：migration → Edge 函式 → 發新版 ASN。回復：換回上述兩份 migration 的函式定義。
begin;

create or replace function public.asn_relay_acct_report(p_node text, p_accounts jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_row jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  if p_accounts is null or jsonb_typeof(p_accounts) <> 'array' or jsonb_array_length(p_accounts) > 20 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active') then
    return jsonb_build_object('error', 'not_found');
  end if;
  for v_row in select * from jsonb_array_elements(p_accounts) loop
    if jsonb_typeof(v_row) <> 'object'
       or v_row->>'vendor' is null or v_row->>'vendor' not in ('claude', 'codex', 'grok')
       or not public.asn_relay_acct_email_ok(v_row->>'email')
       or (v_row ? 'plan' and (jsonb_typeof(v_row->'plan') <> 'string' or char_length(v_row->>'plan') > 30 or (v_row->>'plan') ~ '[[:cntrl:]]'))
       or (v_row ? 'current' and jsonb_typeof(v_row->'current') <> 'boolean') then
      return jsonb_build_object('error', 'bad_request');
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'vendor', v_row->>'vendor', 'email', v_row->>'email', 'plan', coalesce(v_row->>'plan', ''), 'current', coalesce((v_row->>'current')::boolean, false)));
  end loop;
  insert into relay.asn_accounts (node, accounts, updated_at) values (p_node, v_out, now())
    on conflict (node) do update set accounts = excluded.accounts, updated_at = excluded.updated_at;
  return jsonb_build_object('ok', true, 'count', jsonb_array_length(v_out));
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
  v_signed boolean := public.asn_user_owns_node(p_signed_user, p_actor);
begin
  select tenant_id into v_t from relay.nodes
    where id = p_actor and status = 'active'
      and (role = 'owner' or v_signed);
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select bell_topic into v_topic from relay.nodes where id = p_node and status = 'active' and tenant_id is not distinct from v_t;
  if v_topic is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_vendor is null or p_vendor not in ('claude', 'grok') then
    return jsonb_build_object('error', 'bad_vendor');
  end if;
  if not public.asn_relay_acct_email_ok(p_email) then
    return jsonb_build_object('error', 'bad_email');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - interval '3 minutes') then
    return jsonb_build_object('error', 'asn_offline');
  end if;
  if not exists (select 1 from relay.asn_accounts a, jsonb_array_elements(a.accounts) e where a.node = p_node and e->>'vendor' = p_vendor and e->>'email' = p_email) then
    return jsonb_build_object('error', 'unknown_account');
  end if;
  perform public.asn_relay_acct_expire();
  if exists (select 1 from relay.account_switches where node = p_node and status in ('pending', 'taken')) then
    return jsonb_build_object('error', 'busy');
  end if;
  if (select count(*) from relay.account_switches where node = p_node and created_at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.account_switches (tenant_id, requested_by, node, vendor, email, signed)
    values (v_t, p_actor, p_node, p_vendor, p_email, v_signed) returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

revoke all on function public.asn_relay_acct_report(text, jsonb) from public, anon, authenticated;
revoke all on function public.asn_relay_acct_switch(text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_report(text, jsonb) to service_role;
grant execute on function public.asn_relay_acct_switch(text, text, text, text, uuid) to service_role;

commit;
