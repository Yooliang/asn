-- 回復檔（不是 migration，不會被部署；要用時人工執行）。
-- 回復 20261112100000_inbox_watch_per_agent.sql：收信卡住監控換回「整台只看最舊一封」的判法（20261111100000_notice_center.sql 的版本，逐字相同）。
-- 1. 函式換回上一版（排程不動，照舊呼叫 asn_relay_inbox_watch(false)）。
-- 2. 刪掉新種類的狀態紀錄（alert、notify、orphan），檢查式才換得回原本那四種。這些紀錄只是影子跑的對照用，刪了不影響收信。
-- 3. 刪索引 messages_acked_idx（純查詢用，沒有資料）。
-- 新加的欄位保留（都有預設值或可空，上一版不讀也不寫，留著無害）。
-- 注意：要回到通知集中之前的版本，請接著跑 20261111100000_notice_center_revert.sql。
begin;

delete from relay.inbox_watch_log where note in ('alert', 'notify', 'orphan');
alter table relay.inbox_watch_log drop constraint if exists inbox_watch_log_note_check;
alter table relay.inbox_watch_log add constraint inbox_watch_log_note_check
  check (note in ('marked', 'recovered', 'recovered_silent', 'reset_after_offline'));

drop index if exists relay.messages_acked_idx;

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
  v_body text;
  v_kind text;
  v_res jsonb;
  v_nodes int := 0;
  v_stuck_n int := 0;
  v_sent int := 0;
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
      -- 設備名先用 name（使用者取的名字），空白才用 machine（設備種類）；其他八支本來就只用 name
      v_name := coalesce(nullif(btrim(left(regexp_replace(coalesce(nullif(btrim(r.name), ''), r.machine, ''), '[[:cntrl:]]', ' ', 'g'), 40)), ''), '未命名設備');
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
          v_body := v_name || '：收信可能卡住了' || E'\n' || '還在線，但有 ' || r.cnt || ' 封信沒有確認，最舊的已經等了 ' || (extract(epoch from now() - r.oldest) / 60)::int || ' 分鐘。';
        elsif v_state.notified_at is not null and v_state.notified_at <= now() - interval '24 hours' then
          v_kind := 'remind';
          v_body := v_name || '：收信還是卡著' || E'\n' || r.cnt || ' 封信沒有確認，最舊的已經等了 ' || (extract(epoch from now() - r.oldest) / 60)::int || ' 分鐘。';
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
          v_body := v_name || '：收信恢復了';
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
    exception when others then
      raise warning 'inbox_watch: node % failed: %', r.id, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('nodes', v_nodes, 'stuck', v_stuck_n, 'sent', v_sent, 'send_enabled', coalesce(p_send, false));
end;
$function$;
revoke all on function public.asn_relay_inbox_watch(boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_inbox_watch(boolean) to service_role;

commit;
