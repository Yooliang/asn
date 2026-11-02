-- 收發室 worker 的 Claude 額度用完時，這台電腦暫停收信到什麼時候（todo-next-173）：給收信監控用來抑制「長時間沒收信」的通知，
-- 並在暫停開始時由後台寄一封通知給「這個節點自己的擁有者」（擁有者可能人在手機那頭，不寄到本機視窗）。
-- 做法照 20261023090000_mod_status.sql 的 asn_relay_set_claude_mod（節點用自己的金鑰回報，Edge Function relay 的 roster 動作選填欄位，
-- 資料庫函式只動得到金鑰所屬的那一列，只授權 service_role），寄給擁有者的部分照 20261031110000_acct_login_alert_notify.sql 的
-- asn_relay_login_alert（由後台依節點查擁有者，收件人、寄件名、內文格式都在這裡決定，最後呼叫既有的 asn_relay_send）。
--  1. relay.nodes 加 inbox_hold_until（可空）；null＝沒有暫停。
--  2. asn_relay_set_inbox_hold(p_node, p_until, p_held, p_capped)：
--     - p_until 由這裡夾在 now() 到 now()+8 天之間（不信用戶端的時間）；null＝清掉。節點不存在或已停用回 forbidden。
--     - 暫停「從沒有或已過期變成未來時間」時寄一封給擁有者：「這台（設備名，讀 relay.nodes.name，不信電腦端傳來的）的收發室 Claude 額度用完，約 HH:MM（台北）重置；扣住 N 封，重置後自動轉交。」
--       reply=no。暫停期間重複設值、延長時間都不再寄。
--     - p_capped 為真（扣住的信超過上限）且暫停進行中時，另寄一封說明，用戶端每次額度用完只會帶一次。
--     - 設備名取自 relay.nodes.name（去控制字元、最多 40 字）；讀不到就省略括號只寫「這台」。擁有者查不到或核對不過只設時間、不寄信（不影響設定本身）。
--     - 限流：同一節點每小時最多 3 封（寄件名「額度通知收發室」，advisory lock 串行）。
--     - 回傳 {ok:true, bell_topics:[…]}：Edge Function 依此敲門鈴，讓擁有者的畫面立刻看到信。
-- 相容：只新增可空欄位與新函式，沒有改既有函式；舊電腦端不帶欄位＝不動，舊後台沒有這個欄位時電腦端送的值被丟掉，不壞。
-- 部署順序：本 migration → relay（Edge Function）→ 電腦端。
--   部署：npx supabase db query --linked -f supabase/migrations/20261102100000_inbox_hold_until.sql
-- 回復：supabase/sql/rollback/20261102100000_inbox_hold_until_down.sql（已寄出的信不受影響）。
begin;

alter table relay.nodes add column if not exists inbox_hold_until timestamptz;

create or replace function public.asn_relay_set_inbox_hold(p_node text, p_until timestamptz, p_held integer default 0, p_capped boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_old timestamptz;
  v_new timestamptz;
  v_owner uuid;
  v_computer text;
  v_body text;
  v_recent int;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_agent constant text := '額度通知收發室';
begin
  select inbox_hold_until, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_old, v_computer
    from relay.nodes where id = p_node and status = 'active' for update;
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  v_new := case when p_until is null then null else least(greatest(p_until, now()), now() + interval '8 days') end;
  update relay.nodes set inbox_hold_until = v_new where id = p_node;
  if v_new is not null and v_new > now() then
    if v_old is null or v_old <= now() then
      v_body := '這台' || case when v_computer <> '' then '（' || v_computer || '）' else '' end || '的收發室 Claude 額度用完，約 ' || to_char(v_new at time zone 'Asia/Taipei', 'HH24:MI')
        || '（台北）重置；扣住 ' || least(greatest(coalesce(p_held, 0), 0), 99999) || ' 封，重置後自動轉交。';
    elsif coalesce(p_capped, false) then
      v_body := '這台' || case when v_computer <> '' then '（' || v_computer || '）' else '' end || '的收發室扣住的信已達上限，超過的先不收（留在伺服器，重置後再處理）。';
    end if;
    if v_body is not null then
      select owner_user into v_owner from relay.nodes where id = p_node;
      if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
        perform pg_advisory_xact_lock(hashtext('inbox_hold:' || p_node));
        select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
          where from_node = p_node and from_agent = v_agent and created_at > now() - interval '1 hour';
        if v_recent < 3 then
          v_res := public.asn_relay_send(p_node, v_agent, public.asn_person_alias(v_owner), null, v_body, null, false, null, false);
          v_topics := case
            when jsonb_typeof(v_res->'bell_topics') = 'array' then v_res->'bell_topics'
            when jsonb_typeof(v_res->'bell_topic') = 'string' then jsonb_build_array(v_res->'bell_topic')
            else '[]'::jsonb end;
        end if;
      end if;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_set_inbox_hold(text, timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_set_inbox_hold(text, timestamptz, integer, boolean) to service_role;

commit;
