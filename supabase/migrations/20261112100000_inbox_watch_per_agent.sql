-- 收信卡住監控：改成「依收件代理」判斷（todo-next-176；asn真 審定方案）。仍是影子跑，排程不動（照舊呼叫 asn_relay_inbox_watch(false)）。
-- 起因：11-05～11-07 影子跑 8 次「標成卡住」只有 1 次是真的。誤報兩種：
--   1. 單一代理忙（例如審查代理一封信等 17～23 分鐘），整台其實收信正常；
--   2. 寄給不存在的代理（一封信 39 小時沒人收），同一台別的代理照常確認。
--   真卡住的那次是 3 個代理的 7 封信同時卡 46～65 分鐘。
--
-- 新判法（每 5 分鐘，對每個在線節點；在線、手機、額度扣住的條件與原本相同）：
--   - 依 to_agent 分組算未確認信的筆數與最舊一封；to_agent 為空（寄給設備本身）也算一組。
--   - 「不存在的代理」：這台的這個代理 7 天內沒有確認過任何一封信。它的信不列入判斷，只記在 orphan_count，
--     由 0 變成大於 0 時記一筆 orphan（這一版只記錄、不通知）。
--     代價：新代理收到的第一封、或閒置超過 7 天的代理，卡住也不會被算進來（要等它確認過一封才開始看）。
--   - 標成卡住（只記錄）：有任一代理的最舊未確認信超過 15 分鐘（同原本，用來對照）。
--   - 要通知（alert）：2 個以上代理各有信超過 15 分鐘沒確認；或有一個代理的最舊未確認信超過 60 分鐘、而且它 60 分鐘內沒有確認任何信。
--     單一代理慢、還在 60 分鐘內：只記錄、不通知。
--   - 恢復：不算不存在代理，沒有未確認信，或最舊的不到 5 分鐘（同原本）。
--   - 寄信時機：alert 持續 10 分鐘才寄（原本是「標成卡住」後 10 分鐘），還卡著 24 小時再提醒；寄過才寄恢復；限流不變（每台每小時 3 封）。
-- 影子跑對照：狀態紀錄表多一欄 would_notify（這一筆在開寄信時會不會通知）。新的紀錄種類：
--   alert（標成卡住之後才達到通知條件）、notify（這一輪會寄「卡住」；影子跑每段卡住只記一次，用 shadow_noticed_at 擋重複）、orphan。
--   恢復那一筆的 would_notify＝這段卡住有沒有寄過（或影子跑會不會寄過）「卡住」，也就是會不會寄「恢復」。
-- 信的內容（不帶信件內容；代理名去掉控制字元、每個最多 20 字、最多列 2 個）：
--   卡住：「<設備名>：收信可能卡住了」＋「還在線，但寄給 A、B 等 3 個夥伴的 7 封信都沒有送到，最舊的已經等了 52 分鐘。可能要重開 ASN。」
--   恢復：「<設備名>：收信恢復了」＋「卡了約 65 分鐘，期間的 7 封信都送到了。」
--
-- 依賴：20261111100000_notice_center.sql（本函式由它的版本改起，寄信照舊經 asn_relay_send_notice）。部署要在通知集中上線之後。
-- security definer 函式碰到的資料表：與上一版相同（讀 relay.nodes、relay.messages；讀寫 relay.inbox_watch；寫、清理 relay.inbox_watch_log；
--   經 asn_relay_send_notice 寄信），沒有新函式、授權不變（只給 service_role）。
-- 資料表變更（舊的列不受影響）：
--   relay.inbox_watch 加 alert_since、episode_oldest_at、shadow_noticed_at（可空）、stuck_agents、orphan_count（not null default 0）；
--   relay.inbox_watch_log 加 would_notify（not null default false）、agents（可空）；note 的檢查式多收 alert、notify、orphan。
--   新索引 messages_acked_idx (to_node, acked_at) where acked_at is not null：查「這個代理多久沒確認信」用；正式庫約 1.9 萬列，建索引是瞬間的事。
-- 回復：supabase/sql/rollback/20261112100000_inbox_watch_per_agent_down.sql（函式換回通知集中那一版、刪新種類的紀錄、檢查式換回、刪索引；欄位保留）。
begin;

alter table relay.inbox_watch add column if not exists alert_since timestamptz;
alter table relay.inbox_watch add column if not exists episode_oldest_at timestamptz;
alter table relay.inbox_watch add column if not exists shadow_noticed_at timestamptz;
alter table relay.inbox_watch add column if not exists stuck_agents integer not null default 0;
alter table relay.inbox_watch add column if not exists orphan_count integer not null default 0;

alter table relay.inbox_watch_log add column if not exists would_notify boolean not null default false;
alter table relay.inbox_watch_log add column if not exists agents integer;
alter table relay.inbox_watch_log drop constraint if exists inbox_watch_log_note_check;
alter table relay.inbox_watch_log add constraint inbox_watch_log_note_check
  check (note in ('marked', 'recovered', 'recovered_silent', 'reset_after_offline', 'alert', 'notify', 'orphan'));

create index if not exists messages_acked_idx on relay.messages (to_node, acked_at) where acked_at is not null;

create or replace function public.asn_relay_inbox_watch(p_send boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
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
  v_done int;
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
       and n.last_seen_at > now() - interval '3 minutes'
       and coalesce(n.kind, '') <> 'phone'
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
      -- 設備名先用 name（使用者取的名字），空白才用 machine（設備種類）
      v_name := coalesce(nullif(btrim(left(regexp_replace(coalesce(nullif(btrim(r.name), ''), r.machine, ''), '[[:cntrl:]]', ' ', 'g'), 40)), ''), '未命名設備');
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
          -- 期間送到的信（不算通知信本身：卡住通知可能就寄到這一台）
          select count(*)::int into v_done from relay.messages
            where to_node = r.id and created_at >= v_from and acked_at is not null and coalesce(kind, '') not like 'notice:%';
          v_kind := 'recover';
          v_body := v_name || '：收信恢復了' || E'\n' || '卡了約 ' || (extract(epoch from now() - v_from) / 60)::int || ' 分鐘，期間的 ' || v_done || ' 封信都送到了。';
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

commit;
