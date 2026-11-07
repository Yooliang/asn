-- 20261111100000_notice_center.sql 的回復檔（不是 migration，不會被部署；要用時人工執行）。
-- 把九支通知函式與四支讀信函式逐字換回各自的上一版定義：
--   asn_relay_login_alert          ← 20261031110000_acct_login_alert_notify.sql
--   asn_relay_inbox_watch          ← 20261102170000_node_platform_phone.sql
--   asn_relay_set_inbox_hold       ← 20261102160000_inbox_hold_until.sql
--   asn_relay_misroute_notice      ← 20261102200000_misroute_notice.sql
--   asn_relay_waiting_notice       ← 20261104140000_waiting_notice.sql
--   asn_relay_mux_down_notice      ← 20261105110000_mux_down_notice.sql
--   asn_relay_node_mismatch_notice ← 20261106130000_node_mismatch_notice.sql
--   asn_relay_term_view_notice     ← 20261108100000_term_view_scope.sql
--   asn_relay_device_key_alert     ← 20261107130000_device_key_alert.sql
--   asn_relay_inbox、asn_relay_inbox_agent ← 20261023110000_voice_flag.sql
--   asn_relay_inbox_peek           ← 20261022030000_inbox_peek.sql（當時叫 irori_relay_inbox_peek，20261023040000 改名）
--   asn_chat_history               ← 20261023070000_chat_history_before.sql
-- 刻意留著：
--   public.asn_relay_send_notice 與 relay.messages.kind 欄位（含檢查式 messages_kind_check）。函式沒有授權給任何角色、沒有人呼叫就沒有作用；
--   欄位是可空的標記，留著無害，而且已寄出的信帶著 kind，刪欄位會丟資料。要連它們也移除時另寫 migration。
-- 回復後，通知又用各自的舊寄件名（xx收發室）寄出；已寄出的「ASN 通知」信不動。
begin;

-- asn_relay_login_alert（20261031110000_acct_login_alert_notify.sql）
create or replace function public.asn_relay_login_alert(p_node text, p_computer text, p_last_at timestamptz, p_email text default null, p_timeouts integer default 0)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_alias text;
  v_computer text := btrim(coalesce(p_computer, ''));
  v_body text;
  v_recent int;
  v_agent constant text := '登入通知收發室';
begin
  select owner_user into v_owner from relay.nodes where id = p_node and status = 'active';
  if v_owner is null or not public.asn_user_owns_node(v_owner, p_node) then
    return jsonb_build_object('error', 'not_claimed');
  end if;
  if char_length(v_computer) < 1 or char_length(v_computer) > 40 or v_computer ~ '[[:cntrl:]]'
     or p_last_at is null or p_last_at > now() + interval '10 minutes' or p_last_at < now() - interval '24 hours'
     or (p_email is not null and not public.asn_relay_acct_email_ok(p_email))
     or p_timeouts is null or p_timeouts < 0 or p_timeouts > 999 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  perform pg_advisory_xact_lock(hashtext('login_alert:' || p_node));
  select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
    where from_node = p_node and from_agent = v_agent and created_at > now() - interval '1 hour';
  if v_recent >= 3 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  v_alias := public.asn_person_alias(v_owner);
  v_body := v_computer || '的 Claude 登入失效（最後一次錯誤 ' || to_char(p_last_at at time zone 'Asia/Taipei', 'HH24:MI')
    || case when p_email is not null then '，帳號 ' || p_email else '' end || '）。'
    || case when p_timeouts > 0 then '這段時間轉交逾時 ' || p_timeouts || ' 次。' else '' end;
  return public.asn_relay_send(p_node, v_agent, v_alias, null, v_body, null, false, null, false);
end;
$function$;
revoke all on function public.asn_relay_login_alert(text, text, timestamptz, text, integer) from public, anon, authenticated;
grant execute on function public.asn_relay_login_alert(text, text, timestamptz, text, integer) to service_role;

-- asn_relay_inbox_watch（20261102170000_node_platform_phone.sql）
create or replace function public.asn_relay_inbox_watch(p_send boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  r record;
  v_state relay.inbox_watch%rowtype;
  v_level text;
  v_stuck boolean;
  v_ok boolean;
  v_name text;
  v_alias text;
  v_body text;
  v_kind text;
  v_recent int;
  v_res jsonb;
  v_nodes int := 0;
  v_stuck_n int := 0;
  v_sent int := 0;
  v_agent constant text := '收信監控收發室';
begin
  delete from relay.inbox_watch_log where at < now() - interval '30 days';
  for r in
    select n.id, n.name, n.machine, n.owner_user, coalesce(c.cnt, 0) as cnt, c.oldest
      from relay.nodes n
      left join (
        select to_node, count(*) as cnt, min(created_at) as oldest
          from relay.messages where acked_at is null group by to_node
      ) c on c.to_node = n.id
     where n.status = 'active'
       and n.last_seen_at > now() - interval '3 minutes'
       and coalesce(n.kind, '') <> 'phone'
       and coalesce(n.platform, '') not in ('android', 'ios')
       and (n.inbox_hold_until is null or n.inbox_hold_until <= now())
  loop
    v_nodes := v_nodes + 1;
    begin
      v_level := case when r.cnt = 0 then '0' when r.cnt <= 10 then '1-10' when r.cnt <= 50 then '10-50' else '50+' end;
      v_stuck := r.cnt > 0 and r.oldest <= now() - interval '15 minutes';
      v_ok := r.cnt = 0 or r.oldest > now() - interval '5 minutes';
      select * into v_state from relay.inbox_watch where node = r.id for update;
      if not found then
        insert into relay.inbox_watch (node) values (r.id);
        select * into v_state from relay.inbox_watch where node = r.id;
      end if;
      v_name := left(regexp_replace(coalesce(r.machine, r.name, r.id), '[[:cntrl:]]', ' ', 'g'), 40);
      v_body := null;
      v_kind := null;

      -- 離線回來：stuck 的節點離線期間沒被掃到（updated_at 沒更新）。回來要重新起算 10 分鐘，不能拿昨天的 stuck_since 當持續卡著
      if v_state.state = 'stuck' and v_state.updated_at < now() - interval '10 minutes' then
        update relay.inbox_watch set stuck_since = now() where node = r.id;
        v_state.stuck_since := now();
        insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since)
          values (r.id, 'stuck', 'stuck', 'reset_after_offline', r.cnt, r.oldest, now());
      end if;

      if v_stuck and v_state.state = 'ok' then
        -- 第一次判成卡住只標記，不寄：電腦剛開機時信的年齡本來就大，要持續卡著一段時間才寄
        update relay.inbox_watch set state = 'stuck', stuck_since = now(), level = v_level, last_count = r.cnt, last_oldest_at = r.oldest, updated_at = now() where node = r.id;
        insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since)
          values (r.id, 'ok', 'stuck', 'marked', r.cnt, r.oldest, now());
      elsif v_stuck then
        update relay.inbox_watch set level = v_level, last_count = r.cnt, last_oldest_at = r.oldest, updated_at = now() where node = r.id;
        if v_state.notified_at is null and v_state.stuck_since <= now() - interval '10 minutes' then
          -- 標成 stuck 後持續卡著超過 10 分鐘才第一次寄（影子跑期間就標成 stuck 的，開寄信後第一輪補寄）
          v_kind := 'stuck';
          v_body := v_name || ' 還在線，但有 ' || r.cnt || ' 封信沒有確認，最舊的已經等了 ' || (extract(epoch from now() - r.oldest) / 60)::int || ' 分鐘，收信可能卡住了。';
        elsif v_state.notified_at is not null and v_state.notified_at <= now() - interval '24 hours' then
          v_kind := 'remind';
          v_body := v_name || ' 的收信還是卡著：' || r.cnt || ' 封信沒有確認，最舊的已經等了 ' || (extract(epoch from now() - r.oldest) / 60)::int || ' 分鐘。';
        end if;
      elsif v_ok and v_state.state = 'stuck' then
        update relay.inbox_watch set level = v_level, last_count = r.cnt, last_oldest_at = r.oldest, updated_at = now() where node = r.id;
        if v_state.notified_at is null then
          -- 從沒寄過「卡住」（影子跑期間或不到 10 分鐘就恢復了）：直接標回 ok，不寄「恢復」
          update relay.inbox_watch set state = 'ok', stuck_since = null, recovered_at = now() where node = r.id;
          insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since)
            values (r.id, 'stuck', 'ok', 'recovered_silent', r.cnt, r.oldest, v_state.stuck_since);
        else
          -- 寄過「卡住」：寄成功才標回 ok；寄失敗或被限流就保持 stuck，下一輪還符合恢復條件時再試
          v_kind := 'recover';
          v_body := v_name || ' 的收信恢復了。';
        end if;
      else
        -- 介於兩個門檻之間（5～15 分鐘）：保持原狀，只更新數字
        update relay.inbox_watch set level = v_level, last_count = r.cnt, last_oldest_at = r.oldest, updated_at = now() where node = r.id;
      end if;
      if v_stuck then v_stuck_n := v_stuck_n + 1; end if;

      -- 影子跑（p_send = false）：狀態照常更新，不寄信；notified_at 也不記，開寄信後第一輪才會補寄卡著的
      if v_body is not null and p_send then
        if r.owner_user is null or not public.asn_user_owns_node(r.owner_user, r.id) then
          raise warning 'inbox_watch: node % has no resolvable owner, skipped', r.id;
        else
          select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
            where from_node = r.id and from_agent = v_agent and created_at > now() - interval '1 hour';
          if v_recent < 3 then
            -- 寄信放在自己的區塊：寄不出去只是這一輪沒通知，前面更新好的狀態不會一起回復
            begin
              v_alias := public.asn_person_alias(r.owner_user);
              -- asn_relay_send 失敗是回傳 {"error": ...}，不是丟例外：要看回傳值，寄失敗不能當成寄成功
              v_res := public.asn_relay_send(r.id, v_agent, v_alias, null, v_body, null, false, null, false);
              if v_res is null or v_res ? 'error' then
                raise warning 'inbox_watch: send for node % refused: %', r.id, v_res ->> 'error';
              else
                v_sent := v_sent + 1;
                if v_kind = 'recover' then
                  update relay.inbox_watch set state = 'ok', stuck_since = null, notified_at = null, recovered_at = now(), updated_at = now() where node = r.id;
                  insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since)
                    values (r.id, 'stuck', 'ok', 'recovered', r.cnt, r.oldest, v_state.stuck_since);
                else
                  update relay.inbox_watch set notified_at = now() where node = r.id;
                end if;
              end if;
            exception when others then
              raise warning 'inbox_watch: send for node % failed: %', r.id, sqlerrm;
            end;
          end if;
        end if;
      end if;
    exception when others then
      raise warning 'inbox_watch: node % failed: %', r.id, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('nodes', v_nodes, 'stuck', v_stuck_n, 'sent', v_sent, 'send_enabled', coalesce(p_send, false));
end;
$function$;
revoke all on function public.asn_relay_inbox_watch(boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_inbox_watch(boolean) to service_role;

-- asn_relay_set_inbox_hold（20261102160000_inbox_hold_until.sql）
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
  v_notify text := 'skipped';
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
    if v_old is null or v_old <= now() - interval '15 minutes' then
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
        if v_recent >= 3 then
          v_notify := 'rate_limited';
        else
          v_res := public.asn_relay_send(p_node, v_agent, public.asn_person_alias(v_owner), null, v_body, null, false, null, false);
          if v_res is null or v_res ? 'error' then
            v_notify := 'failed';
          else
            v_notify := 'sent';
            v_topics := case
              when jsonb_typeof(v_res->'bell_topics') = 'array' then v_res->'bell_topics'
              when jsonb_typeof(v_res->'bell_topic') = 'string' then jsonb_build_array(v_res->'bell_topic')
              else '[]'::jsonb end;
          end if;
        end if;
      end if;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'notify', v_notify, 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_set_inbox_hold(text, timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_set_inbox_hold(text, timestamptz, integer, boolean) to service_role;

-- asn_relay_misroute_notice（20261102200000_misroute_notice.sql）
create or replace function public.asn_relay_misroute_notice(p_node text, p_mail_id uuid default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_computer text;
  v_body text;
  v_recent int;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_notify text := 'skipped';
  v_agent constant text := '轉交核對收發室';
begin
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_computer
    from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    perform pg_advisory_xact_lock(hashtext('misroute_notice:' || p_node));
    select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
      where from_node = p_node and from_agent = v_agent and created_at > now() - interval '1 hour';
    if v_recent >= 3 then
      v_notify := 'rate_limited';
    else
      v_body := '這台' || case when v_computer <> '' then '（' || v_computer || '）' else '' end || '的收發室把'
        || case when p_mail_id is null then '一則訊息' else '一封信（編號 ' || p_mail_id::text || '）' end
        || '轉交錯了視窗，可能已被讀取；收發室正在重新轉交給原收件人。';
      v_res := public.asn_relay_send(p_node, v_agent, public.asn_person_alias(v_owner), null, v_body, null, false, null, false);
      if v_res is null or v_res ? 'error' then
        v_notify := 'failed';
      else
        v_notify := 'sent';
        v_topics := case
          when jsonb_typeof(v_res->'bell_topics') = 'array' then v_res->'bell_topics'
          when jsonb_typeof(v_res->'bell_topic') = 'string' then jsonb_build_array(v_res->'bell_topic')
          else '[]'::jsonb end;
      end if;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'notify', v_notify, 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_misroute_notice(text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_misroute_notice(text, uuid) to service_role;

-- asn_relay_waiting_notice（20261104140000_waiting_notice.sql）
create or replace function public.asn_relay_waiting_notice(p_node text, p_window text, p_kind text, p_detail text default null, p_tool text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_computer text;
  v_window text;
  v_what text;
  v_body text;
  v_recent int;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_notify text := 'skipped';
  v_agent constant text := '等待確認收發室';
begin
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_computer
    from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  v_window := left(btrim(regexp_replace(coalesce(p_window, ''), '[[:cntrl:]]', '', 'g')), 60);
  v_what := case p_kind when 'permission' then '在等你確認（權限' || case when p_tool ~ '^[A-Za-z0-9_.:-]{1,80}$' then '：' || p_tool else '' end || '）' when 'input' then '在等你回答' when 'other' then '在等你處理' end;
  if v_window = '' or v_what is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    perform pg_advisory_xact_lock(hashtext('waiting_notice:' || p_node));
    select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
      where from_node = p_node and from_agent = v_agent and created_at > now() - interval '1 hour';
    if v_recent >= 6 then
      v_notify := 'rate_limited';
    else
      v_body := '這台' || case when v_computer <> '' then '（' || v_computer || '）' else '' end || '的夥伴「' || v_window || '」' || v_what || '，已經等超過 2 分鐘。';
      if p_kind = 'input' and btrim(coalesce(p_detail, '')) <> '' then
        v_body := v_body || E'\n' || left(btrim(regexp_replace(p_detail, '[[:cntrl:]]', ' ', 'g')), 600);
      end if;
      v_res := public.asn_relay_send(p_node, v_agent, public.asn_person_alias(v_owner), null, v_body, null, false, null, false);
      if v_res is null or v_res ? 'error' then
        v_notify := 'failed';
      else
        v_notify := 'sent';
        v_topics := case
          when jsonb_typeof(v_res->'bell_topics') = 'array' then v_res->'bell_topics'
          when jsonb_typeof(v_res->'bell_topic') = 'string' then jsonb_build_array(v_res->'bell_topic')
          else '[]'::jsonb end;
      end if;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'notify', v_notify, 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_waiting_notice(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_waiting_notice(text, text, text, text, text) to service_role;

-- asn_relay_mux_down_notice（20261105110000_mux_down_notice.sql）
create or replace function public.asn_relay_mux_down_notice(p_node text, p_count integer, p_resumed boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_computer text;
  v_body text;
  v_recent int;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_notify text := 'skipped';
  v_agent constant text := '終端服務收發室';
begin
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_computer
    from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_count is null or p_count < 1 or p_count > 100 or p_resumed is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    perform pg_advisory_xact_lock(hashtext('mux_down_notice:' || p_node));
    select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
      where from_node = p_node and from_agent = v_agent and created_at > now() - interval '1 hour';
    if v_recent >= 6 then
      v_notify := 'rate_limited';
    else
      v_body := '這台' || case when v_computer <> '' then '（' || v_computer || '）' else '' end
        || case when p_resumed
             then '的終端服務中斷了，' || p_count || ' 位夥伴受影響，ASN 正在自動接回。'
             else '的終端服務短時間內又中斷了，' || p_count || ' 位夥伴受影響。這次沒有自動接回，請到這台電腦看一下。'
           end;
      v_res := public.asn_relay_send(p_node, v_agent, public.asn_person_alias(v_owner), null, v_body, null, false, null, false);
      if v_res is null or v_res ? 'error' then
        v_notify := 'failed';
      else
        v_notify := 'sent';
        v_topics := case
          when jsonb_typeof(v_res->'bell_topics') = 'array' then v_res->'bell_topics'
          when jsonb_typeof(v_res->'bell_topic') = 'string' then jsonb_build_array(v_res->'bell_topic')
          else '[]'::jsonb end;
      end if;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'notify', v_notify, 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_mux_down_notice(text, integer, boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_mux_down_notice(text, integer, boolean) to service_role;

-- asn_relay_node_mismatch_notice（20261106130000_node_mismatch_notice.sql）
create or replace function public.asn_relay_node_mismatch_notice(p_node text, p_configured text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_here text;
  v_other text;
  v_body text;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_notify text := 'skipped';
  v_agent constant text := '雲端設定收發室';
begin
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_here
    from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_configured is null or p_configured !~ '^[A-Za-z0-9_-]{1,32}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    if p_configured <> p_node then
      select nullif(left(btrim(regexp_replace(coalesce(n.name, ''), '[[:cntrl:]]', '', 'g')), 40), '') into v_other
        from relay.nodes n where n.id = p_configured and n.owner_user = v_owner and n.status = 'active';
    end if;
    v_body := '有一台雲端代理啟動時發現設定不對：它設定的是'
      || case when v_other is not null then '「' || v_other || '」' else '另一個節點' end
      || '，但金鑰對到的是這台' || case when v_here <> '' then '（' || v_here || '）' else '' end
      || '。可能是貼上另一組設定時把金鑰蓋掉了。為了不用錯的身分收發信，它已經停下來；請把那邊的設定改回同一組再啟動。';
    perform pg_advisory_xact_lock(hashtext('node_mismatch_notice:' || p_node));
    if exists (select 1 from relay.messages where from_node = p_node and from_agent = v_agent and created_at > now() - interval '1 hour') then
      v_notify := 'rate_limited';
    elsif exists (select 1 from relay.messages where from_node = p_node and from_agent = v_agent and body = v_body and created_at > now() - interval '24 hours') then
      v_notify := 'duplicate';
    else
      v_res := public.asn_relay_send(p_node, v_agent, public.asn_person_alias(v_owner), null, v_body, null, false, null, false);
      if v_res is null or v_res ? 'error' then
        v_notify := 'failed';
      else
        v_notify := 'sent';
        v_topics := case
          when jsonb_typeof(v_res->'bell_topics') = 'array' then v_res->'bell_topics'
          when jsonb_typeof(v_res->'bell_topic') = 'string' then jsonb_build_array(v_res->'bell_topic')
          else '[]'::jsonb end;
      end if;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'notify', v_notify, 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_node_mismatch_notice(text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_node_mismatch_notice(text, text) to service_role;

-- asn_relay_term_view_notice（20261108100000_term_view_scope.sql）
create or replace function public.asn_relay_term_view_notice(p_node text, p_id uuid)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  r relay.term_views%rowtype;
  v_owner uuid;
  v_computer text;
  v_viewer text;
  v_window text;
  v_body text;
  v_recent int;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_agent constant text := '看畫面收發室';
begin
  select * into r from relay.term_views where id = p_id and to_node = p_node and status in ('accepted', 'watching', 'paused') for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if r.notified_at is not null then
    return jsonb_build_object('ok', true, 'notify', 'sent', 'bell_topics', '[]'::jsonb);
  end if;
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_computer
    from relay.nodes where id = p_node and status = 'active';
  if not found or v_owner is null or not public.asn_user_owns_node(v_owner, p_node) then
    return jsonb_build_object('ok', true, 'notify', 'skipped', 'bell_topics', '[]'::jsonb);
  end if;
  select left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_viewer from relay.nodes where id = r.from_node;
  perform pg_advisory_xact_lock(hashtext('term_view_notice:' || p_node));
  select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
    where from_node = p_node and from_agent = v_agent and created_at > now() - interval '1 hour';
  if v_recent >= 30 then
    return jsonb_build_object('ok', true, 'notify', 'rate_limited', 'bell_topics', '[]'::jsonb);
  end if;
  v_window := left(regexp_replace(r.window_name, '[[:cntrl:]]', '', 'g'), 64);
  if r.scope = 'input' then
    v_body := '「' || coalesce(v_viewer, '另一台電腦') || '」正在操作這台（' || v_computer || '）夥伴「' || v_window
      || '」的終端：可以在這台打任何字，包括回答權限框。如果不是你，請馬上到這台按結束，並到設定頁「認得的電腦」檢查。';
  else
    v_body := '「' || coalesce(v_viewer, '另一台電腦') || '」正在看這台（' || v_computer || '）夥伴「' || v_window
      || '」的畫面。如果不是你，請到這台按結束，並到設定頁「認得的電腦」檢查。';
  end if;
  v_res := public.asn_relay_send(p_node, v_agent, public.asn_person_alias(v_owner), null, v_body, null, false, null, false);
  if v_res is null or v_res ? 'error' then
    return jsonb_build_object('ok', true, 'notify', 'failed', 'bell_topics', '[]'::jsonb);
  end if;
  update relay.term_views set notified_at = now() where id = r.id;
  v_topics := case
    when jsonb_typeof(v_res->'bell_topics') = 'array' then v_res->'bell_topics'
    when jsonb_typeof(v_res->'bell_topic') = 'string' then jsonb_build_array(v_res->'bell_topic')
    else '[]'::jsonb end;
  return jsonb_build_object('ok', true, 'notify', 'sent', 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_term_view_notice(text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_term_view_notice(text, uuid) to service_role;

-- asn_relay_device_key_alert（20261107130000_device_key_alert.sql）
create or replace function public.asn_relay_device_key_alert(p_node text, p_peer text, p_kind text, p_fp text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_owner uuid;
  v_me text;
  v_peer text;
  v_body text;
  v_recent int;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_agent constant text := '看畫面收發室';
begin
  if p_peer is null or p_peer = p_node or p_kind is null or p_kind not in ('first', 'changed')
     or p_fp is null or p_fp !~ '^[0-9a-f]{16,32}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_me
    from relay.nodes where id = p_node and status = 'active';
  if not found or v_owner is null or not public.asn_user_owns_node(v_owner, p_node) then
    return jsonb_build_object('ok', true, 'notify', 'skipped', 'bell_topics', '[]'::jsonb);
  end if;
  -- 對方要是同一個本人的另一台
  if not public.asn_user_owns_node(v_owner, p_peer) then
    return jsonb_build_object('ok', true, 'notify', 'skipped', 'bell_topics', '[]'::jsonb);
  end if;
  select left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_peer from relay.nodes where id = p_peer;
  perform pg_advisory_xact_lock(hashtext('device_key_alert:' || p_node));
  delete from relay.device_key_alerts where sent_at < now() - interval '2 days';
  if exists (select 1 from relay.device_key_alerts where node = p_node and peer = p_peer and kind = p_kind and sent_at > now() - interval '1 day') then
    return jsonb_build_object('ok', true, 'notify', 'sent', 'bell_topics', '[]'::jsonb);
  end if;
  select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
    where from_node = p_node and from_agent = v_agent and created_at > now() - interval '1 hour';
  if v_recent >= 30 then
    return jsonb_build_object('ok', true, 'notify', 'rate_limited', 'bell_topics', '[]'::jsonb);
  end if;
  if p_kind = 'first' then
    v_body := '「' || coalesce(v_peer, '另一台電腦') || '」第一次連到這台（' || v_me || '），已記住它的設備金鑰（指紋 ' || left(p_fp, 16)
      || '）。如果不是你，請到這台的設定頁「認得的電腦」按忘記，並檢查帳號。';
  else
    v_body := '「' || coalesce(v_peer, '另一台電腦') || '」的設備金鑰變了（新指紋 ' || left(p_fp, 16) || '），這台（' || v_me
      || '）已拒絕連線。如果是你重裝了那台，請到這台的設定頁「認得的電腦」按忘記再連一次；不是的話請不要按，並檢查帳號。';
  end if;
  v_res := public.asn_relay_send(p_node, v_agent, public.asn_person_alias(v_owner), null, v_body, null, false, null, false);
  if v_res is null or v_res ? 'error' then
    return jsonb_build_object('ok', true, 'notify', 'failed', 'bell_topics', '[]'::jsonb);
  end if;
  insert into relay.device_key_alerts (node, peer, kind) values (p_node, p_peer, p_kind)
    on conflict (node, peer, kind) do update set sent_at = now();
  v_topics := case
    when jsonb_typeof(v_res->'bell_topics') = 'array' then v_res->'bell_topics'
    when jsonb_typeof(v_res->'bell_topic') = 'string' then jsonb_build_array(v_res->'bell_topic')
    else '[]'::jsonb end;
  return jsonb_build_object('ok', true, 'notify', 'sent', 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_device_key_alert(text, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_device_key_alert(text, text, text, text) to service_role;

-- asn_relay_inbox（20261023110000_voice_flag.sql）
create or replace function public.asn_relay_inbox(p_node text, p_exclude_agents text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ids uuid[];
  v_out jsonb;
begin
  select coalesce(array_agg(s.id), array[]::uuid[]) into v_ids from (
    select m.id from relay.messages m
    where m.to_node = p_node and m.acked_at is null
      and (p_exclude_agents is null or m.to_agent is null or not (m.to_agent = any(p_exclude_agents)))
    order by m.created_at, m.id limit 50
  ) s;
  update relay.messages set delivered_at = now()
    where id = any(v_ids) and delivered_at is null;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'from_node', relay.person_view_node(m.tenant_id, m.from_node, m.from_agent, m.person_user), 'from_agent', m.from_agent,
      'to_node', m.to_node, 'to_agent', m.to_agent, 'body', m.body,
      'reply_to', m.reply_to, 'created_at', m.created_at, 'expects_reply', m.expects_reply,
      'fanout_id', m.fanout_id, 'voice', m.voice,
      'sender_display', case when m.owner_signed or m.person_user is not null
         then (select nullif(btrim(t.owner_name), '') from relay.tenants t where t.id = m.tenant_id) end,
      'sender_device', f.name,
      'sender_engine', case when f.machine = '雲端代理' then 'cloud'
         else (select r.engine from relay.roster r where r.node = m.from_node and r.name = m.from_agent) end,
      'trust', case when m.owner_signed then 'owner' else 'member' end) order by m.created_at, m.id), '[]'::jsonb)
    into v_out from relay.messages m join relay.nodes f on f.id = m.from_node where m.id = any(v_ids);
  return v_out;
end;
$function$;

-- asn_relay_inbox_agent（20261023110000_voice_flag.sql）
create or replace function public.asn_relay_inbox_agent(p_node text, p_agent text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ids uuid[];
  v_out jsonb;
begin
  if p_agent is null or p_agent = '' then return '[]'::jsonb; end if;
  select coalesce(array_agg(s.id), array[]::uuid[]) into v_ids from (
    select m.id from relay.messages m
    where m.to_node = p_node and m.to_agent = p_agent and m.acked_at is null
    order by m.created_at, m.id limit 50
  ) s;
  update relay.messages set delivered_at = now()
    where id = any(v_ids) and delivered_at is null;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'from_node', relay.person_view_node(m.tenant_id, m.from_node, m.from_agent, m.person_user), 'from_agent', m.from_agent,
      'to_node', m.to_node, 'to_agent', m.to_agent, 'body', m.body,
      'reply_to', m.reply_to, 'created_at', m.created_at, 'expects_reply', m.expects_reply,
      'fanout_id', m.fanout_id, 'voice', m.voice,
      'sender_display', case when m.owner_signed or m.person_user is not null
         then (select nullif(btrim(t.owner_name), '') from relay.tenants t where t.id = m.tenant_id) end,
      'sender_device', f.name,
      'sender_engine', case when f.machine = '雲端代理' then 'cloud'
         else (select r.engine from relay.roster r where r.node = m.from_node and r.name = m.from_agent) end,
      'trust', case when m.owner_signed then 'owner' else 'member' end) order by m.created_at, m.id), '[]'::jsonb)
    into v_out from relay.messages m join relay.nodes f on f.id = m.from_node where m.id = any(v_ids);
  return v_out;
end;
$function$;

-- asn_relay_inbox_peek（20261022030000_inbox_peek.sql（irori_relay_inbox_peek，20261023040000 改名為 asn_relay_inbox_peek））
create or replace function public.asn_relay_inbox_peek(p_node text, p_agent text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_count integer;
  v_msgs jsonb;
begin
  if p_agent is null or p_agent = '' then
    return jsonb_build_object('count', 0, 'messages', '[]'::jsonb);
  end if;
  select count(*) into v_count from relay.messages m
    where m.to_node = p_node and m.to_agent = p_agent and m.acked_at is null;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'from_node', s.from_node, 'from_agent', s.from_agent,
      'created_at', s.created_at, 'body', left(s.body, 200)) order by s.created_at, s.id), '[]'::jsonb)
    into v_msgs from (
      select m.id, m.from_node, m.from_agent, m.created_at, m.body from relay.messages m
      where m.to_node = p_node and m.to_agent = p_agent and m.acked_at is null
      order by m.created_at, m.id limit 50
    ) s;
  return jsonb_build_object('count', v_count, 'messages', v_msgs);
end;
$function$;

-- asn_chat_history（20261023070000_chat_history_before.sql）
create or replace function public.asn_chat_history(p_user uuid, p_node text, p_partner_node text, p_partner_agent text, p_limit integer default 100, p_partner_id text default null::text, p_before timestamptz default null)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_tenant uuid;
  v_alias text := public.asn_person_alias(p_user);
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_pid text := null;
  v_out jsonb;
begin
  if not public.asn_user_owns_node(p_user, p_node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_partner_node is null or p_partner_node !~ '^[A-Za-z0-9_-]{1,32}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select tenant_id into v_tenant from relay.nodes where id = p_node;
  -- 夥伴 ID 只認同租戶的；不是就當沒帶（只用名字比對）
  if p_partner_id is not null and exists (select 1 from relay.partners p where p.partner_id = p_partner_id and p.tenant_id = v_tenant) then
    v_pid := p_partner_id;
  end if;
  select coalesce(jsonb_agg(x.j order by x.at, x.gid), '[]'::jsonb) into v_out from (
    select g.gid, g.at, jsonb_build_object(
        'id', g.own_id, 'fanout_id', g.fanout_id, 'ids', g.ids, 'dir', g.dir, 'body', g.body, 'reply_to', g.reply_to,
        'created_at', g.at, 'delivered_at', g.delivered_at, 'acked_at', g.acked_at,
        'from_node', g.from_node,
        'from_node_name', (select nd.name from relay.nodes nd where nd.id = g.from_node and nd.tenant_id = v_tenant)) as j
    from (
      select coalesce(m.fanout_id, m.id) as gid,
             m.fanout_id as fanout_id,
             -- 同一個 fanout_id 只留一列：呼叫端自己那份優先，沒有就取最早的
             (array_agg(m.id order by coalesce(m.to_node = p_node, false) desc, m.created_at, m.id))[1] as own_id,
             array_agg(m.id order by m.created_at, m.id) as ids,
             case when bool_or(m.from_agent = v_alias) then 'me' else 'them' end as dir,
             min(m.created_at) as at,
             (array_agg(m.body order by m.created_at, m.id))[1] as body,
             (array_agg(m.reply_to order by m.created_at, m.id))[1] as reply_to,
             min(m.delivered_at) as delivered_at,
             min(m.acked_at) as acked_at,
             (array_agg(m.from_node order by m.created_at, m.id))[1] as from_node
      from relay.messages m
      where m.tenant_id = v_tenant
        and m.person_user = p_user
        and m.created_at > now() - interval '90 days'
        and (p_before is null or m.created_at < p_before)
        and (
          (m.from_agent = v_alias and m.to_node = p_partner_node and coalesce(m.to_agent, '') = coalesce(p_partner_agent, ''))
          or (m.from_agent is distinct from v_alias and m.from_node = p_partner_node and coalesce(m.from_agent, '') = coalesce(p_partner_agent, ''))
          or (v_pid is not null and m.from_agent = v_alias and m.to_partner_id = v_pid)
          or (v_pid is not null and m.from_agent is distinct from v_alias and m.from_partner_id = v_pid)
        )
      group by coalesce(m.fanout_id, m.id), m.fanout_id
      order by min(m.created_at) desc, coalesce(m.fanout_id, m.id)
      limit v_limit
    ) g
  ) x;
  return jsonb_build_object('messages', v_out);
end;
$function$;
revoke all on function public.asn_chat_history(uuid, text, text, text, integer, text, timestamptz) from public, anon, authenticated;
grant execute on function public.asn_chat_history(uuid, text, text, text, integer, text, timestamptz) to service_role;

commit;
