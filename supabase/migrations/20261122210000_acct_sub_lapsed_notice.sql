-- Claude 帳號訂閱失效時通知擁有者（#1646 拆項 G／H，擁有者經 #2086 定案）：
--   每台電腦、每個 Claude 帳號，從「非失效」變成 lapsed 的那一次通知一次；已經是 lapsed 不重複；恢復 active 後又變 lapsed 再通知一次。
--   「非失效」＝上一次存的值是 active，或從來沒存過（ASN 第一次就讀到 lapsed 也要通知，擁有者需要知道）。
-- 只換一支函式 asn_relay_acct_report，其餘本體與 20261122200000_acct_sub_state.sql 版逐字相同，只多「偵測轉換、寄通知」：
--   1. 轉換判斷：這一列存進去的值是 lapsed，而且這台上一次存的同 email（不分大小寫）的 claude 列不是 lapsed（沒有這一列＝從沒存過）。
--      帶 unknown 或沒帶時存的是沿用的舊值，舊值若是 lapsed 就不算轉換，若沒有確定值就根本不會是 lapsed，所以這兩種情況都不會寄。
--   2. 整份驗證完、新清單寫進去之後才寄：中途有一列不合格整份退回時，不會留下已寄出的通知。
--   3. 同一份回報裡同一個 email 出現兩次只寄一封。
--   4. 寄信走既有的 asn_relay_send_notice（主題 subscription，限流每台每小時 3 則）；收件人、擁有者檢查（沒認領就略過）都在它裡面，這裡不另做。
--   5. 內文白話：寫電腦名（沒名字寫「電腦（代號末 4 碼）」）、帳號 email、夥伴會停擺、請到「設備與帳號」切換帳號或續訂；不放其他個資。
--   6. 回傳多兩個選填欄位：mail_ids（這次實際寄出的信件 id 陣列）、bell_topics（要敲的門鈴）。舊 Edge 只讀 count，多的欄位被忽略，不會壞；
--      新 Edge 拿 mail_ids 去推手機（照 web_login 的 owner_mail 做法）。沒寄信時兩欄是空陣列。
--   寄信失敗、被限流都不影響回報結果（回報照樣寫入、照樣回 ok）；代價是被限流或寄失敗的那次轉換不會補寄（狀態已存成 lapsed）。
-- 寫入路徑：電腦端（acct_remote.rs）呼叫 Edge 的 acct_report 動作，Edge 先呼叫本函式（只帶 claude／codex／grok 並保留 sub_state），
--   再另呼叫 asn_relay_acct_roster_report；後者不存 sub_state，所以只在本函式偵測。
-- 權限、security definer、search_path 空照舊；沒有改資料表。
-- 相容：舊 Edge 讀 count 照常；新 Edge 打到還沒套本 migration 的舊函式時 mail_ids 不存在＝不推播。
-- 部署順序：本 migration → relay（Edge）→（電腦端不用動）。提早上任何一步都不會壞。
--   部署：npx supabase db query --linked -f supabase/migrations/20261122210000_acct_sub_lapsed_notice.sql（部署前在群組說）。
-- 回復：supabase/sql/rollback/20261122210000_acct_sub_lapsed_notice_down.sql（換回 20261122200000 版本體）。
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
  v_prev text;
  v_alerts text[] := '{}';
  v_email text;
  v_computer text;
  v_body text;
  v_res jsonb;
  v_ids jsonb := '[]'::jsonb;
  v_topics jsonb := '[]'::jsonb;
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
    v_prev := null;
    if v_row->>'vendor' = 'claude' then
      -- 這台上次存的同帳號值（沒有＝從沒存過），拿來判斷是不是「非失效 → 失效」的轉換
      select e->>'sub_state' into v_prev from jsonb_array_elements(v_old) e
        where e->>'vendor' = 'claude' and lower(e->>'email') = lower(v_row->>'email') limit 1;
      v_sub := case when v_row->>'sub_state' in ('active', 'lapsed') then v_row->>'sub_state' else (
        select e->>'sub_state' from jsonb_array_elements(v_old) e
          where e->>'vendor' = 'claude' and lower(e->>'email') = lower(v_row->>'email')
            and e->>'sub_state' in ('active', 'lapsed') limit 1) end;
      -- 轉換：存進去的是 lapsed，上次不是 lapsed（active 或從沒存過）；同一份回報同一個 email 只記一次。這裡只記下來，整份驗證完、寫入之後才寄
      if v_sub = 'lapsed' and v_prev is distinct from 'lapsed' and not (lower(v_row->>'email') = any(v_alerts)) then
        v_alerts := v_alerts || lower(v_row->>'email');
      end if;
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
  -- 寄通知：每個轉換一封，經既有的 asn_relay_send_notice（主題 subscription，每台每小時 3 則）；收件人與擁有者檢查都在裡面。
  -- 寄失敗、被限流都不影響回報結果；只有真的寄出（notify = sent）的信才回 id 給 Edge 推播
  if coalesce(array_length(v_alerts, 1), 0) > 0 then
    select left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_computer from relay.nodes where id = p_node;
    v_computer := coalesce(nullif(v_computer, ''), '電腦（代號末 4 碼 ' || right(p_node, 4) || '）');
    foreach v_email in array v_alerts loop
      v_body := v_computer || '：Claude 訂閱已失效' || E'\n'
        || '帳號 ' || v_email || ' 的訂閱已失效，這台的 Claude 夥伴會停擺。請到「設備與帳號」切換帳號或續訂。';
      -- 二審：寄信丟例外（例如 asn_relay_send_notice 裡的 raise）不能讓整份回報回滾——回滾後下一輪又判成轉換、又丟，
      -- 這台的帳號回報就永遠寫不進去。所以寄信包在自己的子交易裡：失敗只記警告（原文進資料庫 log），回報照樣寫入、回 ok
      begin
        v_res := public.asn_relay_send_notice(p_node, 'subscription', v_body, 3, interval '1 hour');
        if v_res is not null and not (v_res ? 'error') and v_res ->> 'notify' = 'sent' then
          if v_res -> 'send' ->> 'id' is not null then
            v_ids := v_ids || to_jsonb(v_res -> 'send' ->> 'id');
          end if;
          v_topics := v_topics || case when jsonb_typeof(v_res -> 'bell_topics') = 'array' then v_res -> 'bell_topics' else '[]'::jsonb end;
        end if;
      exception when others then
        raise warning 'asn_relay_acct_report: 訂閱失效通知寄送失敗（node=%）：%', p_node, sqlerrm;
      end;
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'count', jsonb_array_length(v_out), 'mail_ids', v_ids, 'bell_topics', v_topics);
end;
$function$;

revoke all on function public.asn_relay_acct_report(text, jsonb) from public, anon, authenticated;
grant execute on function public.asn_relay_acct_report(text, jsonb) to service_role;

commit;
