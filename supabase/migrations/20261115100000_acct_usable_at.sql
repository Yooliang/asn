-- 帳號回報多收一個選填欄位 usable_at（「上次確認可用」，#1512 C2，0.2.25）：手機的設備頁看得到每個 Claude 帳號上次確認還能用的時間。
-- 電腦端（#1563）在切換帳號、切走前核對那個帳號的登入相符時，記下時間；回報時以 UTC、到秒的 ISO 字串帶上（例：2026-11-15T08:05:00Z）。
--
-- 只換 asn_relay_acct_report（寫 relay.asn_accounts，每台電腦一列）一支函式的本體，其餘與現行版逐字相同（現行版＝20261031100000_acct_login_flags.sql）：
--   - 選填；有帶就要是字串、而且是「YYYY-MM-DDTHH:MM:SSZ」格式，否則整份退回 bad_request（跟其他欄位同一條規則）；
--   - 只有 claude 的帳號才存（別家帶了也不存）；沒帶＝不存，跟舊資料同形。
--   asn_relay_acct_list 原樣回傳 accounts，不用改；手機從那裡讀到。
-- 帳號列表（asn_relay_acct_roster_report／asn_relay_acct_roster）這次不動：手機設備頁讀的是上面這一份。
-- 權限：create or replace（security definer／search_path 空照舊），最後照現況 revoke public／anon／authenticated、只 grant service_role；沒有放寬任何權限。
-- 沒有改資料表：不加欄位、不搬資料，只換函式本體。
-- 相容：
--   - 舊版電腦不帶這欄＝與以前完全相同；
--   - 新版電腦打到還沒套這支的後台：Edge Function 若已更新，會把 usable_at 交給舊函式，舊函式逐欄重組時把它丟掉，不會壞；
--   - Edge Function 還沒更新：它的清單整理本來就會丟掉不認得的欄位。
-- 部署順序：本 migration → relay（Edge Function）→ 電腦端／手機（0.2.25）。任何一步提早上都不會壞。
--   部署前先確認線上現行本體跟 20261031100000 版一樣（只用 select）：
--     select md5(pg_get_functiondef('public.asn_relay_acct_report(text,jsonb)'::regprocedure));
--   部署：npx supabase db query --linked -f supabase/migrations/20261115100000_acct_usable_at.sql（部署前在群組說）。
-- 回復：supabase/sql/rollback/20261115100000_acct_usable_at_down.sql（換回現行本體；已存的 usable_at 留在 jsonb 裡，舊函式不讀，無害）。
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
       or (v_row ? 'current' and jsonb_typeof(v_row->'current') <> 'boolean')
       or (v_row ? 'login_failed' and jsonb_typeof(v_row->'login_failed') <> 'boolean')
       or (v_row ? 'login_incomplete' and jsonb_typeof(v_row->'login_incomplete') <> 'boolean')
       or (v_row ? 'usable_at' and (jsonb_typeof(v_row->'usable_at') <> 'string' or (v_row->>'usable_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$')) then
      return jsonb_build_object('error', 'bad_request');
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'vendor', v_row->>'vendor', 'email', v_row->>'email', 'plan', coalesce(v_row->>'plan', ''), 'current', coalesce((v_row->>'current')::boolean, false))
      || case when v_row->'login_failed' = 'true'::jsonb then jsonb_build_object('login_failed', true) else '{}'::jsonb end
      || case when v_row->'login_incomplete' = 'true'::jsonb then jsonb_build_object('login_incomplete', true) else '{}'::jsonb end
      || case when v_row->>'vendor' = 'claude' and v_row ? 'usable_at' then jsonb_build_object('usable_at', v_row->>'usable_at') else '{}'::jsonb end
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
