-- 退回 20261122210000_acct_sub_lapsed_notice.sql：asn_relay_acct_report 換回 20261122200000_acct_sub_state.sql 的本體（不寄訂閱失效通知、回傳不帶 mail_ids）。不刪任何資料；已寄出的通知信留著。
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
  v_old jsonb;
  v_sub text;
begin
  if p_accounts is null or jsonb_typeof(p_accounts) <> 'array' or jsonb_array_length(p_accounts) > 20 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active') then
    return jsonb_build_object('error', 'not_found');
  end if;
  -- 這台上一次回報存的清單：訂閱狀態「沒帶」時沿用它（見上方說明）
  select accounts into v_old from relay.asn_accounts where node = p_node for update;
  v_old := coalesce(v_old, '[]'::jsonb);
  for v_row in select * from jsonb_array_elements(p_accounts) loop
    if jsonb_typeof(v_row) <> 'object'
       or v_row->>'vendor' is null or v_row->>'vendor' not in ('claude', 'codex', 'grok')
       or not public.asn_relay_acct_email_ok(v_row->>'email')
       or (v_row ? 'plan' and (jsonb_typeof(v_row->'plan') <> 'string' or char_length(v_row->>'plan') > 30 or (v_row->>'plan') ~ '[[:cntrl:]]'))
       or (v_row ? 'current' and jsonb_typeof(v_row->'current') <> 'boolean')
       or (v_row ? 'login_failed' and jsonb_typeof(v_row->'login_failed') <> 'boolean')
       or (v_row ? 'login_incomplete' and jsonb_typeof(v_row->'login_incomplete') <> 'boolean')
       or (v_row ? 'usable_at' and (jsonb_typeof(v_row->'usable_at') <> 'string' or (v_row->>'usable_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'))
       or (v_row ? 'sub_state' and (jsonb_typeof(v_row->'sub_state') <> 'string' or (v_row->>'sub_state') not in ('active', 'lapsed', 'unknown'))) then
      return jsonb_build_object('error', 'bad_request');
    end if;
    -- 訂閱狀態（只有 claude）：只有確定的 active／lapsed 會覆寫；帶 unknown（電腦端這輪判不出來）或沒帶（舊版用戶端）
    -- 都沿用這台上次存的確定值（二審：讀不到不代表恢復了，不然帳號卡和通知會來回跳），沒有就不存
    v_sub := null;
    if v_row->>'vendor' = 'claude' then
      v_sub := case when v_row->>'sub_state' in ('active', 'lapsed') then v_row->>'sub_state' else (
        select e->>'sub_state' from jsonb_array_elements(v_old) e
          where e->>'vendor' = 'claude' and lower(e->>'email') = lower(v_row->>'email')
            and e->>'sub_state' in ('active', 'lapsed') limit 1) end;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'vendor', v_row->>'vendor', 'email', v_row->>'email', 'plan', coalesce(v_row->>'plan', ''), 'current', coalesce((v_row->>'current')::boolean, false))
      || case when v_row->'login_failed' = 'true'::jsonb then jsonb_build_object('login_failed', true) else '{}'::jsonb end
      || case when v_row->'login_incomplete' = 'true'::jsonb then jsonb_build_object('login_incomplete', true) else '{}'::jsonb end
      || case when v_row->>'vendor' = 'claude' and v_row ? 'usable_at' then jsonb_build_object('usable_at', v_row->>'usable_at') else '{}'::jsonb end
      || case when v_sub is not null then jsonb_build_object('sub_state', v_sub) else '{}'::jsonb end
      || case when v_row->>'vendor' = 'claude' then public.asn_relay_acct_quota(v_row) else '{}'::jsonb end);
  end loop;
  insert into relay.asn_accounts (node, accounts, updated_at) values (p_node, v_out, now())
    on conflict (node) do update set accounts = excluded.accounts, updated_at = excluded.updated_at;
  return jsonb_build_object('ok', true, 'count', jsonb_array_length(v_out));
end;
$function$;

revoke all on function public.asn_relay_acct_report(text, jsonb) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_report(text, jsonb) to service_role;

commit;
