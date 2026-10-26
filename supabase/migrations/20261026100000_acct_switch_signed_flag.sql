-- 手機切換家用機帳號（#300）：把「這道指令是不是本人簽章發出的」記在指令上，讓對方電腦可以只信任同帳號簽章的指令。
-- 以前對方電腦無從分辨：指令是手機（本人簽章）發的，還是只有節點金鑰的某個節點發的，所以一律要在桌面按確認。
-- 做法：relay.account_switches 加 signed（預設 false）；asn_relay_acct_switch 在「呼叫端帶了簽章，且這個節點與它的租戶都是這個人的」
-- （asn_user_owns_node）時寫 true，其餘一律 false；asn_relay_acct_switch_pending 把 signed 一起交給目標電腦。
-- 沒簽章、簽章不成立的指令 signed 一律 false，與以前行為相同（照舊要桌面確認）。
-- 對方電腦是否因此免確認由桌面設定 remote_trust_signed 決定（可關）；這支 migration 只提供事實，不改任何權限判斷。
-- 舊指令（欄位加上前就存在的列）都是 false。簽章只在發出那一刻成立，之後不能補寫，所以欄位只在 asn_relay_acct_switch 內寫入。
-- 先不套用：部署順序為 migration → 發新版 ASN（桌面）；舊版桌面忽略 signed 欄位，行為不變。
-- 回復：drop 欄位 signed，並換回 20261024130000_acct_switch_signed.sql 與 20261021040000_asn_account_switch.sql 的函式定義。
begin;

alter table relay.account_switches add column if not exists signed boolean not null default false;

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
  insert into relay.account_switches (tenant_id, requested_by, node, vendor, email, signed)
    values (v_t, p_actor, p_node, p_vendor, p_email, v_signed) returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

create or replace function public.asn_relay_acct_switch_pending(p_node text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_out jsonb;
begin
  perform public.asn_relay_acct_expire();
  with t as (
    update relay.account_switches set status = 'taken', taken_at = now()
      where node = p_node and status = 'pending'
      returning id, requested_by, vendor, email, created_at, signed
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'requested_by', t.requested_by, 'vendor', t.vendor, 'email', t.email, 'created_at', t.created_at, 'signed', t.signed) order by t.created_at), '[]'::jsonb)
    into v_out from t;
  return jsonb_build_object('requests', v_out);
end;
$function$;

revoke all on function public.asn_relay_acct_switch(text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.asn_relay_acct_switch_pending(text) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_switch(text, text, text, text, uuid) to service_role;
grant execute on function public.asn_relay_acct_switch_pending(text) to service_role;

commit;
