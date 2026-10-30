-- 退回 20261030100000_acct_reset_times.sql：三支函式換回原版本體（額度整理＝20261024200000 版；寫入＝20261029130000 版；讀取＝20261029100000 版），
-- 再拿掉 relay.asn_user_accounts 的 nodes 欄位（只記 gemini 哪台在用，是回報算出來的，可由之後的回報重建）。
-- 先把 relay 換回前一版再跑；沒換也不會壞：relay 多送的兩個重置時間欄位會被換回的舊函式丟掉。
begin;

create or replace function public.asn_relay_acct_quota(p_row jsonb)
 returns jsonb
 language plpgsql
 set search_path to ''
as $function$
declare
  v_five numeric;
  v_week numeric;
  v_at timestamptz;
  v_reset timestamptz;
  v_out jsonb := '{}'::jsonb;
begin
  if jsonb_typeof(p_row->'five_hour_pct') = 'number' and (p_row->>'five_hour_pct')::numeric between 0 and 100 then
    v_five := round((p_row->>'five_hour_pct')::numeric);
  end if;
  if jsonb_typeof(p_row->'weekly_pct') = 'number' and (p_row->>'weekly_pct')::numeric between 0 and 100 then
    v_week := round((p_row->>'weekly_pct')::numeric);
  end if;
  begin
    if jsonb_typeof(p_row->'at') = 'string' and char_length(p_row->>'at') <= 40 then
      v_at := (p_row->>'at')::timestamptz;
    end if;
  exception when others then
    v_at := null;
  end;
  begin
    if jsonb_typeof(p_row->'reset_at') = 'string' and char_length(p_row->>'reset_at') <= 40 then
      v_reset := (p_row->>'reset_at')::timestamptz;
    end if;
  exception when others then
    v_reset := null;
  end;
  if (v_five is null and v_week is null) or v_at is null or v_at > clock_timestamp() + interval '10 minutes' then
    return '{}'::jsonb;
  end if;
  if v_five is not null then v_out := v_out || jsonb_build_object('five_hour_pct', v_five::int); end if;
  if v_week is not null then v_out := v_out || jsonb_build_object('weekly_pct', v_week::int); end if;
  if v_reset is not null then v_out := v_out || jsonb_build_object('reset_at', to_char(v_reset at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')); end if;
  return v_out || jsonb_build_object('at', to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
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
    v_count := v_count + 1;
  end loop;
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
          'nodes', coalesce((
            select jsonb_agg(jsonb_build_object(
                'node', a.node, 'current', coalesce((e->>'current')::boolean, false),
                'reported_at', to_char(a.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) order by a.node)
              from relay.asn_accounts a
              join relay.nodes n on n.id = a.node
              cross join lateral jsonb_array_elements(a.accounts) e
              where n.owner_user = p_signed_user and public.asn_user_owns_node(p_signed_user, n.id)
                and e->>'vendor' = u.vendor and e->>'email' = u.account), '[]'::jsonb))
        order by u.vendor, u.account)
        from relay.asn_user_accounts u
        where u.user_id = p_signed_user and u.seen_at > now() - interval '30 days'), '[]'::jsonb));
end;
$function$;

alter table relay.asn_user_accounts drop constraint if exists asn_user_accounts_nodes_check;
alter table relay.asn_user_accounts drop column if exists nodes;

revoke all on function public.asn_relay_acct_quota(jsonb) from public, anon, authenticated;
revoke all on function public.asn_relay_acct_roster_report(text, jsonb) from public, anon, authenticated;
revoke all on function public.asn_relay_acct_roster(text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_quota(jsonb) to service_role;
grant execute on function public.asn_relay_acct_roster_report(text, jsonb) to service_role;
grant execute on function public.asn_relay_acct_roster(text, uuid) to service_role;

commit;
