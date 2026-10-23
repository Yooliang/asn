-- 帳號回報放寬為可帶多個廠商（claude、codex）：讓「設定 → 設備」看得到其他設備的 OpenAI（Codex）目前登入帳號。
-- 只改兩支函式（以 20261021040000 的定義為基礎，函式名已由改名 migration 換成 asn_relay_*）：
--   1. asn_relay_acct_report：vendor 可以是 claude 或 codex；仍只留 vendor／email／plan／current 四欄，最多 20 筆。
--   2. asn_relay_acct_switch：「email 在對方回報的清單裡」改成只比對 claude 那幾筆，不能拿 codex 帳號當切換目標。
-- 舊名（irori 開頭）的包裝只轉呼叫新名，會跟著生效。切換指令表仍只允許 claude。
-- 相容：舊用戶端只送 claude，照舊通過；新用戶端打到還沒套這支的舊後台時，會退回只送 claude（見 acct_remote.rs）。
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
       or v_row->>'vendor' is null or v_row->>'vendor' not in ('claude', 'codex')
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

create or replace function public.asn_relay_acct_switch(p_actor text, p_node text, p_vendor text, p_email text)
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
  select tenant_id into v_t from relay.nodes where id = p_actor and role = 'owner' and status = 'active';
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

revoke all on function public.asn_relay_acct_report(text, jsonb) from public, anon, authenticated;
revoke all on function public.asn_relay_acct_switch(text, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_report(text, jsonb) to service_role;
grant execute on function public.asn_relay_acct_switch(text, text, text, text) to service_role;

commit;
