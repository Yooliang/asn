-- 退回 20261031100000_acct_login_flags.sql：三支函式換回現行本體（回報＝20261026200000 版；名單寫入、讀出＝20261030100000 版）。
-- 已存進 jsonb 的 login_failed／login_incomplete 留著，舊函式不讀，無害。
begin;

create or replace FUNCTION public.asn_relay_acct_report(p_node text, p_accounts jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      'vendor', v_row->>'vendor', 'email', v_row->>'email', 'plan', coalesce(v_row->>'plan', ''), 'current', coalesce((v_row->>'current')::boolean, false))
      || case when v_row->>'vendor' = 'claude' then public.asn_relay_acct_quota(v_row) else '{}'::jsonb end);
  end loop;
  insert into relay.asn_accounts (node, accounts, updated_at) values (p_node, v_out, now())
    on conflict (node) do update set accounts = excluded.accounts, updated_at = excluded.updated_at;
  return jsonb_build_object('ok', true, 'count', jsonb_array_length(v_out));
end;
$function$;

create or replace function public.asn_relay_acct_roster_report(p_node text, p_accounts jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_user uuid;
  v_now timestamptz := now();
  v_row jsonb;
  v_vendor text;
  v_email text;
  v_plan text;
  v_new jsonb;
  v_merged jsonb;
  v_w jsonb;
  v_o jsonb;
  v_reason text;
  v_skipped jsonb := '[]'::jsonb;
  v_count int := 0;
  v_gemini text[] := '{}';
begin
  if p_accounts is null or jsonb_typeof(p_accounts) <> 'array' or jsonb_array_length(p_accounts) > 20 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select owner_user into v_user from relay.nodes where id = p_node and status = 'active';
  if v_user is null or not public.asn_user_owns_node(v_user, p_node) then
    return jsonb_build_object('error', 'not_claimed');
  end if;
  -- 先整份檢查（跟舊的 asn_relay_acct_report 同一套），不合格就什麼都不寫
  for v_row in select * from jsonb_array_elements(p_accounts) loop
    if jsonb_typeof(v_row) <> 'object'
       or v_row->>'vendor' is null or v_row->>'vendor' not in ('claude', 'codex', 'grok', 'gemini')
       or not public.asn_relay_acct_email_ok(v_row->>'email')
       or (v_row ? 'plan' and (jsonb_typeof(v_row->'plan') <> 'string' or char_length(v_row->>'plan') > 30 or (v_row->>'plan') ~ '[[:cntrl:]]')) then
      return jsonb_build_object('error', 'bad_request');
    end if;
  end loop;
  -- 依 (vendor, email) 的順序逐筆鎖，兩台電腦以相反順序回報同兩個帳號時不會互等成死結（#524 審查）
  for v_row in select e from jsonb_array_elements(p_accounts) with ordinality t(e, i) order by e->>'vendor', lower(e->>'email'), i loop
    v_vendor := v_row->>'vendor';
    v_email := v_row->>'email';
    v_plan := btrim(coalesce(v_row->>'plan', ''));
    v_new := case
      when v_vendor = 'grok' then '[]'::jsonb
      when v_row ? 'windows' then public.asn_relay_acct_windows_clean(v_vendor, v_row->'windows', p_node, v_now)
      else '[]'::jsonb end;
    -- 沒帶 windows、或帶了但清完一窗都不剩：Claude 退回舊四欄（#524 審查）
    if v_vendor = 'claude' and v_new = '[]'::jsonb then
      v_new := public.asn_relay_acct_legacy_windows(v_row, p_node);
    end if;
    insert into relay.asn_user_accounts (user_id, vendor, account, plan, seen_node)
      values (v_user, v_vendor, v_email, v_plan, p_node)
      on conflict (user_id, vendor, account) do nothing;
    select windows into v_merged from relay.asn_user_accounts
      where user_id = v_user and vendor = v_vendor and account = v_email for update;
    for v_w in select e from jsonb_array_elements(v_new) with ordinality t(e, i) order by i loop
      select e into v_o from jsonb_array_elements(v_merged) e where e->>'name' = v_w->>'name' limit 1;
      v_reason := public.asn_relay_acct_window_judge(v_vendor, v_w->>'name', v_o, v_w, v_now);
      if v_reason is not null then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('vendor', v_vendor, 'window', v_w->>'name', 'reason', v_reason));
      elsif v_o is null then
        v_merged := v_merged || jsonb_build_array(v_w);
      else
        select jsonb_agg(case when e->>'name' = v_w->>'name' then v_w else e end order by i) into v_merged
          from jsonb_array_elements(v_merged) with ordinality t(e, i);
      end if;
    end loop;
    if jsonb_array_length(v_merged) > 4 then
      select jsonb_agg(s.e order by s.i) into v_merged from (
        select e, i from jsonb_array_elements(v_merged) with ordinality t(e, i) order by e->>'read_at' desc, i limit 4) s;
    end if;
    update relay.asn_user_accounts
      set windows = v_merged, plan = case when v_plan <> '' then v_plan else plan end,
          seen_at = v_now, seen_node = p_node, updated_at = v_now
      where user_id = v_user and vendor = v_vendor and account = v_email;
    -- Gemini 哪台在用（#374）：把這台的那一格換成這次回報的（current 照電腦端；最多留 20 台，新的在前）
    if v_vendor = 'gemini' then
      v_gemini := v_gemini || v_email;
      update relay.asn_user_accounts
        set nodes = (select coalesce(jsonb_agg(x.e order by x.k), '[]'::jsonb) from (
            select e, k from (
              select jsonb_build_object('node', p_node, 'current', coalesce(v_row->'current' = 'true'::jsonb, false),
                       'reported_at', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) e, 0::bigint k
              union all
              select e, k from jsonb_array_elements(nodes) with ordinality t(e, k) where e->>'node' is distinct from p_node
            ) a order by k limit 20) x)
        where user_id = v_user and vendor = v_vendor and account = v_email;
    end if;
    v_count := v_count + 1;
  end loop;
  -- 這次回報沒有的 gemini 帳號：這台已經不用了，拿掉這台的那一格
  update relay.asn_user_accounts u
    set nodes = (select coalesce(jsonb_agg(e order by k), '[]'::jsonb) from jsonb_array_elements(u.nodes) with ordinality t(e, k) where e->>'node' is distinct from p_node)
    where u.user_id = v_user and u.vendor = 'gemini' and not (u.account = any(v_gemini))
      and exists (select 1 from jsonb_array_elements(u.nodes) e where e->>'node' = p_node);
  delete from relay.asn_user_accounts d
    using (select vendor, account from relay.asn_user_accounts where user_id = v_user
             order by seen_at desc, updated_at desc, created_at desc offset 100) x
    where d.user_id = v_user and d.vendor = x.vendor and d.account = x.account;
  return jsonb_build_object('ok', true, 'count', v_count, 'skipped', v_skipped);
end;
$function$;

create or replace function public.asn_relay_acct_roster(p_actor text, p_signed_user uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  return jsonb_build_object(
    'now', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object(
          'vendor', u.vendor, 'account', u.account, 'plan', u.plan, 'windows', u.windows,
          'seen_at', to_char(u.seen_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'seen_node', u.seen_node,
          'nodes', case when u.vendor = 'gemini' then coalesce((
            -- Gemini 不在舊表：從這個帳號自己記的那幾台取（#374）
            select jsonb_agg(jsonb_build_object(
                'node', e->>'node', 'current', coalesce(e->'current' = 'true'::jsonb, false), 'reported_at', e->>'reported_at') order by e->>'node')
              from jsonb_array_elements(u.nodes) e
              join relay.nodes n on n.id = e->>'node'
              where n.owner_user = p_signed_user and public.asn_user_owns_node(p_signed_user, n.id)), '[]'::jsonb)
          else coalesce((
            select jsonb_agg(jsonb_build_object(
                'node', a.node, 'current', coalesce((e->>'current')::boolean, false),
                'reported_at', to_char(a.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) order by a.node)
              from relay.asn_accounts a
              join relay.nodes n on n.id = a.node
              cross join lateral jsonb_array_elements(a.accounts) e
              where n.owner_user = p_signed_user and public.asn_user_owns_node(p_signed_user, n.id)
                and e->>'vendor' = u.vendor and e->>'email' = u.account), '[]'::jsonb) end)
        order by u.vendor, u.account)
        from relay.asn_user_accounts u
        where u.user_id = p_signed_user and u.seen_at > now() - interval '30 days'), '[]'::jsonb));
end;
$function$;

revoke all on function public.asn_relay_acct_report(text, jsonb) from public, anon, authenticated;
revoke all on function public.asn_relay_acct_roster_report(text, jsonb) from public, anon, authenticated;
revoke all on function public.asn_relay_acct_roster(text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_report(text, jsonb) to service_role;
grant execute on function public.asn_relay_acct_roster_report(text, jsonb) to service_role;
grant execute on function public.asn_relay_acct_roster(text, uuid) to service_role;

commit;
