-- 設備沒有名字時，所有通知的後備寫法統一成「電腦（X7K2）」「手機（Q9Z8）」（接 #1881／#2173）。
-- 起因：登入失效通知已改成「後台名字空白寫電腦（代號末 4 碼）」，和介面 unnamedClue、Rust unnamed_clue 同一種；
--   其餘通知還各寫各的：收信卡住、橋通知退回電腦主機名稱（machine）；額度、轉錯視窗、等待、終端服務、壓縮…寫「未命名設備」；
--   訂閱失效寫「電腦（代號末 4 碼 xxxx）」，格式和介面不同。同一台沒名字的設備，在通知列表裡出現三種寫法。
-- 做法：
--   1. 新增 relay.device_label(p_node)：有名字回名字（清掉控制字元、最多 40 字，和各通知原本取名的規則相同）；
--      沒名字回「電腦（代號末 4 碼大寫）」或「手機（…）」，代號沒有英數字就只回「電腦」或「手機」。
--      手機的判斷：relay.nodes.kind = 'phone'，或 platform 是 android／ios（收信卡住監控判斷手機也是這兩個條件）；其餘一律當電腦。
--      stable、search_path 空，不是 security definer，只授權 service_role（呼叫它的通知函式都是 security definer）。
--   2. asn_relay_login_alert 的後備改用它：有名字時寫出來的字不變；沒名字時原本一律寫「電腦（…）」，現在手機節點寫「手機（…）」，
--      代號沒有英數字時原本寫「電腦（）」，現在只寫「電腦」。
--   3. 下面各支通知函式只換「沒名字時的後備那一段」，其餘一字不動，簽章與權限不變：
--        asn_relay_inbox_watch（上一版 20261123120000_online_window.sql）：不再退回 machine
--        asn_relay_send_bridge_notice（20261111110000_bridge_notice.sql）：不再退回 machine
--        asn_relay_set_inbox_hold、asn_relay_misroute_notice、asn_relay_node_mismatch_notice、asn_relay_term_view_notice、
--          asn_relay_device_key_alert（20261111100000_notice_center.sql）
--        asn_relay_waiting_notice（20261123130000_waiting_notice_forward_stuck.sql）
--        asn_relay_mux_down_notice、asn_relay_mux_blind_notice（20261112200000_mux_down_empty.sql）
--        asn_relay_mux_resume_notice（20261120100000_mux_resume_notice.sql）
--        asn_relay_compact_notice（20261120200000_compact_notice.sql）
--        asn_relay_acct_report（訂閱失效通知，20261122210000_acct_sub_lapsed_notice.sql）
--        asn_relay_login_alert（20261123220000_login_alert_device_name.sql）
--      另外 term_view_notice 的「對方電腦」、device_key_alert 的「對方電腦」原本沒名字時寫「另一台電腦」（名字空字串時甚至是空白），
--      同樣改成 relay.device_label(對方代號)。
-- 相容：只換通知內文裡沒名字時的那一小段字；函式簽章、回傳形狀、限流、寄信都不變。舊版 ASN 不受影響（它們只呼叫這些函式）。
-- 部署順序：只有這一支 migration，沒有 Edge、ASN 要跟著發；先後都不會壞。
-- 回復：supabase/sql/rollback/20261124100000_unnamed_device_label_down.sql（各函式換回上一版本體，最後 drop relay.device_label）。
begin;

create or replace function relay.device_label(p_node text)
 returns text
 language sql
 stable
 set search_path to ''
as $function$
  select coalesce(
    nullif(left(btrim(regexp_replace(coalesce(n.name, ''), '[[:cntrl:]]', '', 'g')), 40), ''),
    case when coalesce(n.kind, '') = 'phone' or coalesce(n.platform, '') in ('android', 'ios') then '手機' else '電腦' end
      || case when t.tail <> '' then '（' || t.tail || '）' else '' end)
  from (select upper(right(regexp_replace(coalesce(p_node, ''), '[^0-9A-Za-z]', '', 'g'), 4)) as tail) t
  left join relay.nodes n on n.id = p_node;
$function$;
revoke all on function relay.device_label(text) from public, anon, authenticated;
grant execute on function relay.device_label(text) to service_role;

create or replace function public.asn_relay_login_alert(p_node text, p_computer text, p_last_at timestamptz, p_email text default null, p_timeouts integer default 0)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_computer text;
  v_body text;
  v_res jsonb;
begin
  -- 設備名只有一份：後台記的名字（relay.nodes.name，和設備頁同一份）。p_computer 是舊版 ASN 帶的電腦主機名稱，不再採用（#1881）
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_computer
    from relay.nodes where id = p_node and status = 'active';
  if v_owner is null or not public.asn_user_owns_node(v_owner, p_node) then
    return jsonb_build_object('error', 'not_claimed');
  end if;
  -- 後台名字空白時寫辨認線索「電腦（代號末 4 碼）」，和畫面上設備名空白時同一種寫法
  v_computer := coalesce(nullif(v_computer, ''), relay.device_label(p_node));
  if p_last_at is null or p_last_at > now() + interval '10 minutes' or p_last_at < now() - interval '24 hours'
     or (p_email is not null and not public.asn_relay_acct_email_ok(p_email))
     or p_timeouts is null or p_timeouts < 0 or p_timeouts > 999 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  perform pg_advisory_xact_lock(hashtext('login_alert:' || p_node));
  v_body := v_computer || '：Claude 登入失效' || E'\n'
    || '最後一次錯誤 ' || to_char(p_last_at at time zone 'Asia/Taipei', 'HH24:MI')
    || case when p_email is not null then '，帳號 ' || p_email else '' end || '。'
    || case when p_timeouts > 0 then '這段時間轉交逾時 ' || p_timeouts || ' 次。' else '' end;
  -- 限流（同一節點每小時 3 封）改由 asn_relay_send_notice 依「節點＋種類」計算；本函式的回傳維持舊形狀
  v_res := public.asn_relay_send_notice(p_node, 'login', v_body, 3, interval '1 hour');
  if v_res is null then
    return jsonb_build_object('error', 'send_failed');
  end if;
  if v_res ->> 'notify' = 'rate_limited' then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  if v_res ? 'error' then
    return v_res;
  end if;
  return coalesce(v_res -> 'send', jsonb_build_object('error', 'send_failed'));
end;
$function$;
revoke all on function public.asn_relay_login_alert(text, text, timestamptz, text, integer) from public, anon, authenticated;
grant execute on function public.asn_relay_login_alert(text, text, timestamptz, text, integer) to service_role;

-- asn_relay_inbox_watch(boolean)（上一版：20261123120000_online_window.sql）
create or replace function public.asn_relay_inbox_watch(p_send boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r record;
  a record;
  v_state relay.inbox_watch%rowtype;
  v_level text;
  v_stuck boolean;
  v_alert boolean;
  v_ok boolean;
  v_name text;
  v_body text;
  v_kind text;
  v_res jsonb;
  v_who text;
  v_mins int;
  v_from timestamptz;
  v_nodes int := 0;
  v_stuck_n int := 0;
  v_alert_n int := 0;
  v_sent int := 0;
begin
  delete from relay.inbox_watch_log where at < now() - interval '30 days';
  for r in
    select n.id, n.name, n.machine, n.owner_user
      from relay.nodes n
     where n.status = 'active'
       and n.last_seen_at > now() - relay.online_window()
       and coalesce(n.kind, '') not in ('phone', 'web')
       and coalesce(n.platform, '') not in ('android', 'ios')
       and (n.inbox_hold_until is null or n.inbox_hold_until <= now())
  loop
    v_nodes := v_nodes + 1;
    begin
      -- 依收件代理分組；last_ack＝這台的這個代理 7 天內最後一次確認信的時間（空＝不存在的代理）
      select coalesce(sum(s.cnt) filter (where s.last_ack is not null), 0)::int as cnt,
             min(s.oldest) filter (where s.last_ack is not null) as oldest,
             count(*) filter (where s.last_ack is not null and s.oldest <= now() - interval '15 minutes')::int as agents15,
             coalesce(sum(s.cnt) filter (where s.last_ack is not null and s.oldest <= now() - interval '15 minutes'), 0)::int as cnt15,
             coalesce(bool_or(s.last_ack is not null and s.oldest <= now() - interval '60 minutes' and s.last_ack <= now() - interval '60 minutes'), false) as one60,
             count(*) filter (where s.last_ack is null)::int as orphans
        into a
        from (
          select u.to_agent, u.cnt, u.oldest,
                 (select max(m.acked_at) from relay.messages m
                   where m.to_node = r.id and m.acked_at > now() - interval '7 days' and m.to_agent is not distinct from u.to_agent) as last_ack
            from (select to_agent, count(*) as cnt, min(created_at) as oldest
                    from relay.messages where to_node = r.id and acked_at is null group by to_agent) u
        ) s;

      v_level := case when a.cnt = 0 then '0' when a.cnt <= 10 then '1-10' when a.cnt <= 50 then '10-50' else '50+' end;
      v_stuck := a.agents15 > 0;
      v_alert := a.agents15 >= 2 or a.one60;
      v_ok := a.cnt = 0 or a.oldest > now() - interval '5 minutes';
      select * into v_state from relay.inbox_watch where node = r.id for update;
      if not found then
        insert into relay.inbox_watch (node) values (r.id);
        select * into v_state from relay.inbox_watch where node = r.id;
      end if;
      -- 設備名用 name（使用者取的名字），空白寫辨認線索「電腦（代號末 4 碼）」（和其餘通知同一種，不再退回 machine）
      v_name := coalesce(nullif(btrim(left(regexp_replace(coalesce(r.name, ''), '[[:cntrl:]]', ' ', 'g'), 40)), ''), relay.device_label(r.id));
      v_body := null;
      v_kind := null;

      -- 寄到不存在代理的信：只記錄。由 0 變成大於 0 時記一筆
      if a.orphans > 0 and v_state.orphan_count = 0 then
        insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since, would_notify, agents)
          values (r.id, v_state.state, v_state.state, 'orphan', a.orphans, null, v_state.stuck_since, false, a.orphans);
      end if;

      -- 離線回來：stuck 的節點離線期間沒被掃到（updated_at 沒更新）。回來要重新起算，不能拿昨天的時間當持續卡著
      if v_state.state = 'stuck' and v_state.updated_at < now() - interval '10 minutes' then
        update relay.inbox_watch set stuck_since = now(), alert_since = case when alert_since is null then null else now() end where node = r.id;
        v_state.stuck_since := now();
        if v_state.alert_since is not null then v_state.alert_since := now(); end if;
        insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since, would_notify, agents)
          values (r.id, 'stuck', 'stuck', 'reset_after_offline', a.cnt, a.oldest, now(), false, a.agents15);
      end if;

      if v_stuck and v_state.state = 'ok' then
        -- 第一次判成卡住只標記，不寄：要達到通知條件、而且持續 10 分鐘才寄
        update relay.inbox_watch set state = 'stuck', stuck_since = now(), episode_oldest_at = a.oldest,
            alert_since = case when v_alert then now() end, shadow_noticed_at = null,
            level = v_level, last_count = a.cnt, last_oldest_at = a.oldest, stuck_agents = a.agents15, orphan_count = a.orphans, updated_at = now()
          where node = r.id;
        insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since, would_notify, agents)
          values (r.id, 'ok', 'stuck', 'marked', a.cnt, a.oldest, now(), v_alert, a.agents15);
      elsif v_stuck then
        update relay.inbox_watch set level = v_level, last_count = a.cnt, last_oldest_at = a.oldest, stuck_agents = a.agents15, orphan_count = a.orphans, updated_at = now()
          where node = r.id;
        if v_alert and v_state.alert_since is null then
          -- 標成卡住之後才達到通知條件（例如單一代理卡過 60 分鐘、或第二個代理也卡了）：從現在起算 10 分鐘
          update relay.inbox_watch set alert_since = now() where node = r.id;
          v_state.alert_since := now();
          insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since, would_notify, agents)
            values (r.id, 'stuck', 'stuck', 'alert', a.cnt, a.oldest, v_state.stuck_since, true, a.agents15);
        elsif not v_alert and v_state.alert_since is not null and v_state.notified_at is null then
          -- 還沒寄過就退回「只是單一代理慢」：取消起算，之後再達到條件重新算 10 分鐘
          update relay.inbox_watch set alert_since = null where node = r.id;
          v_state.alert_since := null;
        end if;
        if v_alert then
          -- 卡住的代理名（依最舊的信排序，最多列 2 個）
          select string_agg(x.nm, '、' order by x.oldest) into v_who
            from (
              select coalesce(nullif(btrim(left(regexp_replace(coalesce(u.to_agent, ''), '[[:cntrl:]]', ' ', 'g'), 20)), ''), '這台設備') as nm, u.oldest
                from (select to_agent, min(created_at) as oldest
                        from relay.messages where to_node = r.id and acked_at is null group by to_agent) u
               where u.oldest <= now() - interval '15 minutes'
                 and exists (select 1 from relay.messages m
                              where m.to_node = r.id and m.acked_at > now() - interval '7 days' and m.to_agent is not distinct from u.to_agent)
               order by u.oldest
               limit 2
            ) x;
          v_who := v_who || case when a.agents15 > 2 then ' 等 ' || a.agents15 || ' 個夥伴的 ' else ' 的 ' end;
          v_mins := (extract(epoch from now() - a.oldest) / 60)::int;
          if v_state.notified_at is null and v_state.alert_since <= now() - interval '10 minutes' then
            v_kind := 'stuck';
            v_body := v_name || '：收信可能卡住了' || E'\n' || '還在線，但寄給 ' || v_who || a.cnt15 || ' 封信都沒有送到，最舊的已經等了 ' || v_mins || ' 分鐘。可能要重開 ASN。';
          elsif v_state.notified_at is not null and v_state.notified_at <= now() - interval '24 hours' then
            v_kind := 'remind';
            v_body := v_name || '：收信還是卡著' || E'\n' || '寄給 ' || v_who || a.cnt15 || ' 封信沒有送到，最舊的已經等了 ' || v_mins || ' 分鐘。';
          end if;
        end if;
      elsif v_ok and v_state.state = 'stuck' then
        update relay.inbox_watch set level = v_level, last_count = a.cnt, last_oldest_at = a.oldest, stuck_agents = 0, orphan_count = a.orphans, updated_at = now()
          where node = r.id;
        if v_state.notified_at is null then
          -- 從沒寄過「卡住」：直接標回 ok，不寄「恢復」；would_notify 記影子跑時會不會寄過（＝開寄信時會不會寄恢復）
          update relay.inbox_watch set state = 'ok', stuck_since = null, alert_since = null, episode_oldest_at = null, shadow_noticed_at = null, recovered_at = now()
            where node = r.id;
          insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since, would_notify, agents)
            values (r.id, 'stuck', 'ok', 'recovered_silent', a.cnt, a.oldest, v_state.stuck_since, v_state.shadow_noticed_at is not null, 0);
        else
          -- 寄過「卡住」：寄成功才標回 ok；寄失敗或被限流就保持 stuck，下一輪還符合恢復條件時再試
          v_from := coalesce(v_state.episode_oldest_at, v_state.stuck_since);
          v_kind := 'recover';
          v_body := v_name || '：收信恢復了' || E'\n' || '卡了約 ' || (extract(epoch from now() - v_from) / 60)::int || ' 分鐘，現在都送到了。';
        end if;
      else
        -- 介於兩個門檻之間（5～15 分鐘），或本來就正常：保持原狀，只更新數字
        update relay.inbox_watch set level = v_level, last_count = a.cnt, last_oldest_at = a.oldest, stuck_agents = a.agents15, orphan_count = a.orphans, updated_at = now()
          where node = r.id;
      end if;
      if v_stuck then v_stuck_n := v_stuck_n + 1; end if;
      if v_stuck and v_alert then v_alert_n := v_alert_n + 1; end if;

      if v_body is not null and not coalesce(p_send, false) then
        -- 影子跑：不寄信、不記 notified_at；「這一輪會寄卡住」每段卡住只記一筆
        if v_kind = 'stuck' and v_state.shadow_noticed_at is null then
          update relay.inbox_watch set shadow_noticed_at = now() where node = r.id;
          insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since, would_notify, agents)
            values (r.id, 'stuck', 'stuck', 'notify', a.cnt15, a.oldest, v_state.stuck_since, true, a.agents15);
        end if;
      elsif v_body is not null then
        if r.owner_user is null or not public.asn_user_owns_node(r.owner_user, r.id) then
          raise warning 'inbox_watch: node % has no resolvable owner, skipped', r.id;
        else
          -- 寄信放在自己的區塊：寄不出去只是這一輪沒通知，前面更新好的狀態不會一起回復
          begin
            -- 限流（同一節點每小時 3 封，被限流這一輪就不寄）由 asn_relay_send_notice 依「節點＋種類」計算
            v_res := public.asn_relay_send_notice(r.id, 'inbox_watch', v_body, 3, interval '1 hour');
            -- 寄失敗是回傳 {"error": ...} 或 notify = 'failed'，不是丟例外：要看回傳值，寄失敗不能當成寄成功
            if v_res is null or v_res ? 'error' or v_res ->> 'notify' = 'failed' then
              raise warning 'inbox_watch: send for node % refused: %', r.id, coalesce(v_res ->> 'error', v_res ->> 'notify');
            elsif v_res ->> 'notify' = 'sent' then
              v_sent := v_sent + 1;
              if v_kind = 'recover' then
                update relay.inbox_watch set state = 'ok', stuck_since = null, alert_since = null, episode_oldest_at = null, shadow_noticed_at = null,
                    notified_at = null, recovered_at = now(), updated_at = now()
                  where node = r.id;
                insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since, would_notify, agents)
                  values (r.id, 'stuck', 'ok', 'recovered', a.cnt, a.oldest, v_state.stuck_since, true, 0);
              else
                update relay.inbox_watch set notified_at = now() where node = r.id;
                if v_kind = 'stuck' then
                  insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since, would_notify, agents)
                    values (r.id, 'stuck', 'stuck', 'notify', a.cnt15, a.oldest, v_state.stuck_since, true, a.agents15);
                end if;
              end if;
            end if;
          exception when others then
            raise warning 'inbox_watch: send for node % failed: %', r.id, sqlerrm;
          end;
        end if;
      end if;
    exception when others then
      raise warning 'inbox_watch: node % failed: %', r.id, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('nodes', v_nodes, 'stuck', v_stuck_n, 'alert', v_alert_n, 'sent', v_sent, 'send_enabled', coalesce(p_send, false));
end;
$function$;
revoke all on function public.asn_relay_inbox_watch(boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_inbox_watch(boolean) to service_role;

-- asn_relay_send_bridge_notice(text, uuid, text)（上一版：20261111110000_bridge_notice.sql）
create or replace function public.asn_relay_send_bridge_notice(p_node text, p_reply_to uuid, p_body text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  r relay.messages%rowtype;
  v_owner uuid;
  v_from_owner uuid;
  v_machine text;
  v_name text;
  v_text text;
  v_body text;
  v_n int;
  v_res jsonb;
  v_id uuid;
  v_topics jsonb := '[]'::jsonb;
  v_kind constant text := 'notice:bridge';
  v_agent constant text := 'ASN 通知';
  v_per_mail constant int := 3;
  v_per_hour constant int := 120;
begin
  if p_node is null or p_reply_to is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 控制字元一律清掉（換行與 tab 保留，\r 一起清）；長度規則同 asn_relay_send_core，留 64 字給第一行的設備名
  v_text := regexp_replace(coalesce(p_body, ''), '[\x01-\x08\x0b-\x1f\x7f]', '', 'g');
  if char_length(btrim(v_text)) < 1 or char_length(v_text) > 19936 then
    return jsonb_build_object('error', 'bad_body');
  end if;
  -- 設備名用 name（使用者取的設備名）；沒有名字時下面寫辨認線索，不再退回 machine
  select owner_user, nullif(btrim(name), '') into v_owner, v_machine from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  -- 同一個節點的橋通知全部排隊判斷：每封原信的次數與每小時的次數都在這個鎖裡數
  perform pg_advisory_xact_lock(hashtext('notice:' || p_node || ':' || v_kind));
  select * into r from relay.messages
    where id = p_reply_to and to_node = p_node and created_at > now() - interval '24 hours';
  if not found or r.from_node is null then
    return jsonb_build_object('error', 'no_origin');
  end if;
  if coalesce(r.kind, '') like 'notice:%' or r.from_agent = v_agent then
    return jsonb_build_object('error', 'is_notice');
  end if;
  select owner_user into v_from_owner from relay.nodes where id = r.from_node;
  if v_owner is null or v_from_owner is null or v_from_owner <> v_owner
     or not public.asn_user_owns_node(v_owner, p_node) or not public.asn_user_owns_node(v_owner, r.from_node) then
    return jsonb_build_object('error', 'cross_account');
  end if;
  select count(distinct coalesce(fanout_id, id)) into v_n from relay.messages
    where from_node = p_node and kind = v_kind and reply_to = p_reply_to;
  if v_n >= v_per_mail then
    return jsonb_build_object('ok', true, 'notify', 'per_mail_limit', 'bell_topics', '[]'::jsonb);
  end if;
  select count(distinct coalesce(fanout_id, id)) into v_n from relay.messages
    where from_node = p_node and kind = v_kind and created_at > now() - interval '1 hour';
  if v_n >= v_per_hour then
    return jsonb_build_object('ok', true, 'notify', 'rate_limited', 'bell_topics', '[]'::jsonb);
  end if;
  v_name := coalesce(nullif(btrim(left(regexp_replace(coalesce(v_machine, ''), '[[:cntrl:]]', ' ', 'g'), 40)), ''), relay.device_label(p_node));
  v_body := v_name || '：' || v_text;
  v_res := public.asn_relay_send(p_node, v_agent, r.from_node, nullif(r.from_agent, ''), v_body, p_reply_to, false, null, false);
  if v_res is null or v_res ? 'error' then
    return jsonb_build_object('ok', true, 'notify', 'failed', 'bell_topics', '[]'::jsonb, 'send', v_res);
  end if;
  -- 同一次寄出的每一列（含扇出）都標上種類；寄信結果沒有 id 就整筆回滾，不留沒有 kind 的通知
  v_id := nullif(coalesce(v_res ->> 'id', v_res ->> 'fanout_id'), '')::uuid;
  if v_id is null then
    raise exception 'asn_relay_send_bridge_notice: send result has no id';
  end if;
  update relay.messages set kind = v_kind
    where from_node = p_node and kind is null and (id = v_id or fanout_id = v_id);
  v_topics := case
    when jsonb_typeof(v_res -> 'bell_topics') = 'array' then v_res -> 'bell_topics'
    when jsonb_typeof(v_res -> 'bell_topic') = 'string' then jsonb_build_array(v_res -> 'bell_topic')
    else '[]'::jsonb end;
  return jsonb_build_object('ok', true, 'notify', 'sent', 'id', v_id, 'bell_topics', v_topics, 'fanout', v_res -> 'fanout');
end;
$function$;
revoke all on function public.asn_relay_send_bridge_notice(text, uuid, text) from public, anon, authenticated;
grant execute on function public.asn_relay_send_bridge_notice(text, uuid, text) to service_role;

-- asn_relay_set_inbox_hold(text, timestamptz, integer, boolean)（上一版：20261111100000_notice_center.sql）
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
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_notify text := 'skipped';
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
      v_body := coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '：Claude 額度用完' || E'\n' || '收發室約 ' || to_char(v_new at time zone 'Asia/Taipei', 'HH24:MI')
        || '（台北）重置；扣住 ' || least(greatest(coalesce(p_held, 0), 0), 99999) || ' 封，重置後自動轉交。';
    elsif coalesce(p_capped, false) then
      v_body := coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '：扣住的信已達上限' || E'\n' || '超過的先不收（留在伺服器，重置後再處理）。';
    end if;
    if v_body is not null then
      select owner_user into v_owner from relay.nodes where id = p_node;
      if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
        perform pg_advisory_xact_lock(hashtext('inbox_hold:' || p_node));
          v_res := public.asn_relay_send_notice(p_node, 'quota', v_body, 3, interval '1 hour');
          if v_res is null or v_res ? 'error' then
            v_notify := 'failed';
          else
            v_notify := coalesce(v_res ->> 'notify', 'failed');
            v_topics := coalesce(v_res -> 'bell_topics', '[]'::jsonb);
          end if;
      end if;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'notify', v_notify, 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_set_inbox_hold(text, timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_set_inbox_hold(text, timestamptz, integer, boolean) to service_role;

-- asn_relay_misroute_notice(text, uuid)（上一版：20261111100000_notice_center.sql）
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
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_notify text := 'skipped';
begin
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_computer
    from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    perform pg_advisory_xact_lock(hashtext('misroute_notice:' || p_node));
    v_body := coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '：信轉交錯了視窗' || E'\n' || '收發室把'
      || case when p_mail_id is null then '一則訊息' else '一封信（編號 ' || p_mail_id::text || '）' end
      || '轉交錯了視窗，可能已被讀取；收發室正在重新轉交給原收件人。';
    v_res := public.asn_relay_send_notice(p_node, 'misroute', v_body, 3, interval '1 hour');
    if v_res is null or v_res ? 'error' then
      v_notify := 'failed';
    else
      v_notify := coalesce(v_res ->> 'notify', 'failed');
      v_topics := coalesce(v_res -> 'bell_topics', '[]'::jsonb);
    end if;
  end if;
  return jsonb_build_object('ok', true, 'notify', v_notify, 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_misroute_notice(text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_misroute_notice(text, uuid) to service_role;

-- asn_relay_waiting_notice(text, text, text, text, text)（上一版：20261123130000_waiting_notice_forward_stuck.sql）
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
  v_reason text;
  v_count text;
  v_body text;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_notify text := 'skipped';
begin
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_computer
    from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  v_window := left(btrim(regexp_replace(coalesce(p_window, ''), '[[:cntrl:]]', '', 'g')), 60);
  v_what := case p_kind when 'permission' then '在等你確認（權限' || case when p_tool ~ '^[A-Za-z0-9_.:-]{1,80}$' then '：' || p_tool else '' end || '）' when 'input' then '在等你回答' when 'other' then '在等你處理' when 'login' then 'Claude 登入過期，要重新登入' when 'forward_stuck' then '收發室轉交連續被擋' when 'forward_stuck_manual' then '收發室轉交連續被擋' end;
  if v_window = '' or v_what is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    perform pg_advisory_xact_lock(hashtext('waiting_notice:' || p_node));
    if p_kind in ('forward_stuck', 'forward_stuck_manual') then
      v_reason := case p_detail
        when 'frame' then '帶了信件外框' when 'no_id' then '第一行沒有轉交編號' when 'missing_fields' then '缺少收件人或內容'
        when 'recipient_conflict' then '兩個收件人欄位不一致' when 'wrong_to' then '收件人填錯' when 'head_mismatch' then '抬頭和原信不一致'
        when 'not_in_flight' then '這封信已不在轉交中' when 'record_unreadable' then '轉交紀錄暫時讀不到' else '原因不明' end;
      v_count := case when p_tool ~ '^[0-9]{1,2}$' then p_tool else '多' end;
      if p_kind = 'forward_stuck' then
        v_body := coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '：「' || v_window || '」' || v_what || ' ' || v_count || ' 次（原因：' || v_reason || '），已自動換一輪新的對話；排隊中的信會在新的一輪重新轉交。';
      else
        v_body := coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '：「' || v_window || '」' || v_what || ' ' || v_count || ' 次（原因：' || v_reason || '），已自動換過 3 輪還是被擋，已停止自動換輪，需要人工處理（請重開這台的收發室）。';
      end if;
    elsif p_kind = 'login' then
      v_body := coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '：「' || v_window || '」' || v_what || '。';
    else
      v_body := coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '：夥伴「' || v_window || '」' || v_what || E'\n' || '已經等超過 2 分鐘。';
    end if;
    if p_kind = 'input' and btrim(coalesce(p_detail, '')) <> '' then
      v_body := v_body || E'\n' || left(btrim(regexp_replace(p_detail, '[[:cntrl:]]', ' ', 'g')), 600);
    end if;
    -- 登入過期、轉交被擋各用自己的種類：名額（每節點每小時 6 封）與等待確認的 6 封分開算
    v_res := public.asn_relay_send_notice(p_node, case when p_kind = 'login' then 'waiting_login' when p_kind in ('forward_stuck', 'forward_stuck_manual') then 'forward_stuck' else 'waiting' end, v_body, 6, interval '1 hour');
    if v_res is null or v_res ? 'error' then
      v_notify := 'failed';
    else
      v_notify := coalesce(v_res ->> 'notify', 'failed');
      v_topics := coalesce(v_res -> 'bell_topics', '[]'::jsonb);
    end if;
  end if;
  return jsonb_build_object('ok', true, 'notify', v_notify, 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_waiting_notice(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_waiting_notice(text, text, text, text, text) to service_role;

-- asn_relay_mux_down_notice(text, integer, boolean)（上一版：20261112200000_mux_down_empty.sql）
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
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_notify text := 'skipped';
begin
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_computer
    from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  -- 0＝服務裡沒有夥伴：只通知服務停了（11-10 30家用：裡面沒有夥伴時崩潰、被帶走都沒有任何訊號）
  if p_count is null or p_count < 0 or p_count > 100 or p_resumed is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    perform pg_advisory_xact_lock(hashtext('mux_down_notice:' || p_node));
    v_body := coalesce(nullif(v_computer, ''), relay.device_label(p_node))
      || case when p_count = 0
           then '：這台的終端服務停了' || E'\n' || 'ASN 沒有看到夥伴開在裡面。如果有夥伴是開在終端服務裡的，請到「' || coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '」重新叫醒它們。'
         when p_resumed
           then '：終端服務中斷了' || E'\n' || p_count || ' 位夥伴受影響，ASN 正在自動接回。'
           else '：終端服務短時間內又中斷了' || E'\n' || p_count || ' 位夥伴受影響。這次沒有自動接回，請到「' || coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '」看一下。'
         end;
    v_res := public.asn_relay_send_notice(p_node, 'mux_down', v_body, 6, interval '1 hour');
    if v_res is null or v_res ? 'error' then
      v_notify := 'failed';
    else
      v_notify := coalesce(v_res ->> 'notify', 'failed');
      v_topics := coalesce(v_res -> 'bell_topics', '[]'::jsonb);
    end if;
  end if;
  return jsonb_build_object('ok', true, 'notify', v_notify, 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_mux_down_notice(text, integer, boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_mux_down_notice(text, integer, boolean) to service_role;

-- asn_relay_mux_blind_notice(text)（上一版：20261112200000_mux_down_empty.sql）
create or replace function public.asn_relay_mux_blind_notice(p_node text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_computer text;
  v_body text;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_notify text := 'skipped';
begin
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_computer
    from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    v_body := coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '：ASN 看不到終端服務的狀態' || E'\n'
      || '已經約 5 分鐘看不到，這段期間夥伴的窗格出事時不會自動接回。請重開 ASN；重開後還是這樣，請回報。';
    v_res := public.asn_relay_send_notice(p_node, 'mux_blind', v_body, 1, interval '24 hours');
    if v_res is null or v_res ? 'error' then
      v_notify := 'failed';
    else
      v_notify := coalesce(v_res ->> 'notify', 'failed');
      v_topics := coalesce(v_res -> 'bell_topics', '[]'::jsonb);
    end if;
  end if;
  return jsonb_build_object('ok', true, 'notify', v_notify, 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_mux_blind_notice(text) from public, anon, authenticated;
grant execute on function public.asn_relay_mux_blind_notice(text) to service_role;

-- asn_relay_node_mismatch_notice(text, text)（上一版：20261111100000_notice_center.sql）
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
    v_body := coalesce(nullif(v_here, ''), relay.device_label(p_node)) || '：雲端代理啟動時發現設定不對' || E'\n'
      || '它設定的是' || case when v_other is not null then '「' || v_other || '」' else '另一個節點' end
      || '，但金鑰對到的是「' || coalesce(nullif(v_here, ''), relay.device_label(p_node)) || '」。可能是貼上另一組設定時把金鑰蓋掉了。為了不用錯的身分收發信，它已經停下來；請把那邊的設定改回同一組再啟動。';
    perform pg_advisory_xact_lock(hashtext('node_mismatch_notice:' || p_node));
    if exists (select 1 from relay.messages where from_node = p_node and kind = 'notice:node_mismatch' and created_at > now() - interval '1 hour') then
      v_notify := 'rate_limited';
    elsif exists (select 1 from relay.messages where from_node = p_node and kind = 'notice:node_mismatch' and body = v_body and created_at > now() - interval '24 hours') then
      v_notify := 'duplicate';
    else
      v_res := public.asn_relay_send_notice(p_node, 'node_mismatch', v_body, 1, interval '1 hour');
      if v_res is null or v_res ? 'error' then
        v_notify := 'failed';
      else
        v_notify := coalesce(v_res ->> 'notify', 'failed');
        v_topics := coalesce(v_res -> 'bell_topics', '[]'::jsonb);
      end if;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'notify', v_notify, 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_node_mismatch_notice(text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_node_mismatch_notice(text, text) to service_role;

-- asn_relay_term_view_notice(text, uuid)（上一版：20261111100000_notice_center.sql）
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
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
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
  v_window := left(regexp_replace(r.window_name, '[[:cntrl:]]', '', 'g'), 64);
  if r.scope = 'input' then
    v_body := coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '：「' || coalesce(nullif(v_viewer, ''), relay.device_label(r.from_node)) || '」正在操作夥伴「' || v_window || '」的終端' || E'\n'
      || '可以在「' || coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '」打任何字，包括回答權限框。如果不是你，請馬上到「' || coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '」按結束，並到設定頁「認得的電腦」檢查。';
  else
    v_body := coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '：「' || coalesce(nullif(v_viewer, ''), relay.device_label(r.from_node)) || '」正在看夥伴「' || v_window || '」的畫面' || E'\n'
      || '如果不是你，請到「' || coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '」按結束，並到設定頁「認得的電腦」檢查。';
  end if;
  -- 限流（同一節點每小時 30 封）由 asn_relay_send_notice 依「節點＋種類」計算
  v_res := public.asn_relay_send_notice(p_node, 'view', v_body, 30, interval '1 hour');
  if v_res is null or v_res ? 'error' or v_res ->> 'notify' = 'failed' then
    return jsonb_build_object('ok', true, 'notify', 'failed', 'bell_topics', '[]'::jsonb);
  end if;
  if v_res ->> 'notify' <> 'sent' then
    return jsonb_build_object('ok', true, 'notify', v_res ->> 'notify', 'bell_topics', '[]'::jsonb);
  end if;
  update relay.term_views set notified_at = now() where id = r.id;
  v_topics := coalesce(v_res -> 'bell_topics', '[]'::jsonb);
  return jsonb_build_object('ok', true, 'notify', 'sent', 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_term_view_notice(text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_term_view_notice(text, uuid) to service_role;

-- asn_relay_device_key_alert(text, text, text, text)（上一版：20261111100000_notice_center.sql）
create or replace function public.asn_relay_device_key_alert(p_node text, p_peer text, p_kind text, p_fp text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_owner uuid;
  v_me text;
  v_peer text;
  v_body text;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
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
  if p_kind = 'first' then
    v_body := coalesce(nullif(v_me, ''), relay.device_label(p_node)) || '：「' || coalesce(nullif(v_peer, ''), relay.device_label(p_peer)) || '」第一次連到「' || coalesce(nullif(v_me, ''), relay.device_label(p_node)) || '」' || E'\n'
      || '已記住它的設備金鑰（指紋 ' || left(p_fp, 16) || '）。如果不是你，請到「' || coalesce(nullif(v_me, ''), relay.device_label(p_node)) || '」的設定頁「認得的電腦」按忘記，並檢查帳號。';
  else
    v_body := coalesce(nullif(v_me, ''), relay.device_label(p_node)) || '：「' || coalesce(nullif(v_peer, ''), relay.device_label(p_peer)) || '」的設備金鑰變了' || E'\n'
      || '新指紋 ' || left(p_fp, 16) || '，已拒絕連線。如果是你重裝了那台，請到「' || coalesce(nullif(v_me, ''), relay.device_label(p_node)) || '」的設定頁「認得的電腦」按忘記再連一次；不是的話請不要按，並檢查帳號。';
  end if;
  -- 限流（同一節點每小時 30 封）由 asn_relay_send_notice 依「節點＋種類」計算
  v_res := public.asn_relay_send_notice(p_node, 'device_key', v_body, 30, interval '1 hour');
  if v_res is null or v_res ? 'error' or v_res ->> 'notify' = 'failed' then
    return jsonb_build_object('ok', true, 'notify', 'failed', 'bell_topics', '[]'::jsonb);
  end if;
  if v_res ->> 'notify' <> 'sent' then
    return jsonb_build_object('ok', true, 'notify', v_res ->> 'notify', 'bell_topics', '[]'::jsonb);
  end if;
  insert into relay.device_key_alerts (node, peer, kind) values (p_node, p_peer, p_kind)
    on conflict (node, peer, kind) do update set sent_at = now();
  v_topics := coalesce(v_res -> 'bell_topics', '[]'::jsonb);
  return jsonb_build_object('ok', true, 'notify', 'sent', 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_device_key_alert(text, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_device_key_alert(text, text, text, text) to service_role;

-- asn_relay_mux_resume_notice(text, integer, integer, text[])（上一版：20261120100000_mux_resume_notice.sql）
create or replace function public.asn_relay_mux_resume_notice(p_node text, p_count integer, p_resumed integer, p_failed text[])
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_computer text;
  v_body text;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_notify text := 'skipped';
  v_names text[];
  v_shown text;
  v_failed_n integer;
begin
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_computer
    from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_count is null or p_count < 1 or p_count > 100 or p_resumed is null or p_resumed < 0 or p_resumed > p_count
     or p_failed is null or coalesce(array_length(p_failed, 1), 0) > 100 or p_resumed + coalesce(array_length(p_failed, 1), 0) <> p_count then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 名字清單重新清過：去控制字元、去頭尾空白、最多 40 字、空的丟掉、同名只留第一個（保持原順序）
  select coalesce(array_agg(n order by o), '{}') into v_names from (
    select distinct on (n) n, o from (
      select left(btrim(regexp_replace(coalesce(x, ''), '[[:cntrl:]]', '', 'g')), 40) as n, o
        from unnest(p_failed) with ordinality as t(x, o)
    ) c where n <> '' order by n, o
  ) d;
  v_failed_n := coalesce(array_length(v_names, 1), 0);
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    perform pg_advisory_xact_lock(hashtext('mux_resume_notice:' || p_node));
    v_shown := array_to_string(v_names[1:8], '、') || case when v_failed_n > 8 then '等共 ' || v_failed_n || ' 位' else '' end;
    v_body := coalesce(nullif(v_computer, ''), relay.device_label(p_node))
      || case
           when p_resumed = p_count
             then '：終端服務中斷，夥伴已全部接回' || E'\n' || '斷了 ' || p_count || ' 位，已接回 ' || p_resumed || ' 位。'
           when p_resumed = 0
             then '：終端服務中斷，夥伴沒有接回' || E'\n' || '斷了 ' || p_count || ' 位，沒有接回'
                  || case when v_failed_n > 0 then '：' || v_shown else '' end
                  || '。請到「' || coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '」手動叫醒它們。'
           else '：終端服務中斷，部分夥伴還沒接回' || E'\n' || '斷了 ' || p_count || ' 位，已接回 ' || p_resumed || ' 位。還沒接回'
                  || case when v_failed_n > 0 then '：' || v_shown else '' end
                  || '。請到「' || coalesce(nullif(v_computer, ''), relay.device_label(p_node)) || '」手動叫醒它們。'
         end;
    -- 和事故當下那則同一個種類（mux_down）；兩則加起來一次事故最多 2 則，限流看同一台一小時 6 則
    v_res := public.asn_relay_send_notice(p_node, 'mux_down', v_body, 6, interval '1 hour');
    if v_res is null or v_res ? 'error' then
      v_notify := 'failed';
    else
      v_notify := coalesce(v_res ->> 'notify', 'failed');
      v_topics := coalesce(v_res -> 'bell_topics', '[]'::jsonb);
    end if;
  end if;
  return jsonb_build_object('ok', true, 'notify', v_notify, 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_mux_resume_notice(text, integer, integer, text[]) from public, anon, authenticated;
grant execute on function public.asn_relay_mux_resume_notice(text, integer, integer, text[]) to service_role;

-- asn_relay_compact_notice(text, text, integer, text, text, integer)（上一版：20261120200000_compact_notice.sql）
create or replace function public.asn_relay_compact_notice(p_node text, p_window text, p_count integer, p_kind text, p_reason text, p_pct integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_computer text;
  v_win text;
  v_dev text;
  v_body text;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_notify text := 'skipped';
  v_how text;
begin
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_computer
    from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  v_win := left(btrim(regexp_replace(coalesce(p_window, ''), '[[:cntrl:]]', '', 'g')), 40);
  if v_win = ''
     or p_count is null or p_count < 1 or p_count > 100
     or p_kind is null or p_kind not in ('auto', 'remind_quota', 'remind_unknown', 'remind_off', 'remind_failed')
     or (p_pct is not null and (p_pct < 0 or p_pct > 100))
     or (p_kind = 'remind_quota' and (p_reason is null or p_reason not in ('5 小時', '每週')))
     or (p_kind <> 'remind_quota' and p_reason is not null) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  v_dev := coalesce(nullif(v_computer, ''), relay.device_label(p_node));
  if v_owner is not null and public.asn_user_owns_node(v_owner, p_node) then
    perform pg_advisory_xact_lock(hashtext('compact_notice:' || p_node));
    v_how := '到 設定 → 設備 → ' || v_dev || ' → 工作管理員，按「交接」。';
    v_body := v_dev || '：' || v_win || ' 壓縮 ' || p_count || ' 次，' || case when p_kind = 'auto' then '已自動交接' else '請交接' end || E'\n'
      || case p_kind
           when 'auto'
             then '「' || v_win || '」這次開窗後已壓縮 ' || p_count || ' 次，額度還夠，已經交給新視窗接手。' || E'\n'
                  || '做了這些：查額度' || case when p_pct is not null then '（5 小時剩 ' || p_pct || '%）' else '' end || '、寫交接檔、開新視窗、關掉舊視窗。' || E'\n'
                  || '新視窗的名字還是「' || v_win || '」，壓縮次數從 0 次算起。' || E'\n'
                  || '不想自動交接：設定 → 視窗與系統匣，取消勾選「壓縮 ' || p_count || ' 次自動交接」。'
           when 'remind_quota'
             then '「' || v_win || '」這次開窗後已壓縮 ' || p_count || ' 次，額度不夠（' || p_reason || case when p_pct is not null then '剩 ' || p_pct || '%' else '' end || '），沒有自動交接。' || E'\n'
                  || '做了這些：只寄這封信，沒有動那個視窗。' || E'\n'
                  || '額度恢復後，' || v_how
           when 'remind_unknown'
             then '「' || v_win || '」這次開窗後已壓縮 ' || p_count || ' 次，讀不到額度，沒有自動交接。' || E'\n'
                  || '做了這些：只寄這封信，沒有動那個視窗。' || E'\n'
                  || v_how
           when 'remind_off'
             then '「' || v_win || '」這次開窗後已壓縮 ' || p_count || ' 次。你在設定裡取消了自動交接，所以只提醒。' || E'\n'
                  || v_how
           else
                  '「' || v_win || '」這次開窗後已壓縮 ' || p_count || ' 次，自動交接沒成功，沒有動那個視窗，所以只提醒。' || E'\n'
                  || '做了這些：只寄這封信，沒有動那個視窗。' || E'\n'
                  || v_how
         end;
    v_res := public.asn_relay_send_notice(p_node, 'compact', v_body, 6, interval '1 hour');
    if v_res is null or v_res ? 'error' then
      v_notify := 'failed';
    else
      v_notify := coalesce(v_res ->> 'notify', 'failed');
      v_topics := coalesce(v_res -> 'bell_topics', '[]'::jsonb);
    end if;
  end if;
  return jsonb_build_object('ok', true, 'notify', v_notify, 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_compact_notice(text, text, integer, text, text, integer) from public, anon, authenticated;
grant execute on function public.asn_relay_compact_notice(text, text, integer, text, text, integer) to service_role;

-- asn_relay_acct_report(text, jsonb)（訂閱失效通知；上一版：20261122210000_acct_sub_lapsed_notice.sql）
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
    v_computer := coalesce(nullif(v_computer, ''), relay.device_label(p_node));
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
