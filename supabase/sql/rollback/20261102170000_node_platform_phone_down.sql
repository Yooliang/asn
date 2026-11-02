-- 回復 20261102170000_node_platform_phone.sql：platform 是 android／ios 的先改成空（不然約束加不回去），約束與三個函式換回原文，drop 新函式。
begin;
update relay.nodes set platform = null where platform in ('android', 'ios');
alter table relay.nodes drop constraint if exists nodes_platform_check;
alter table relay.nodes add constraint nodes_platform_check check (platform is null or platform in ('linux', 'windows', 'macos'));
drop function if exists public.asn_relay_set_node_platform(text, text);

create or replace function public.asn_setup_request(p_user uuid, p_node text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_r relay.setup_requests%rowtype;
begin
  -- 不是自己的節點、或節點不存在：一律 not_found（不透露別人帳號下有沒有這台）
  if p_user is null or not exists (select 1 from relay.nodes where id = p_node and status = 'active' and owner_user = p_user) then
    return jsonb_build_object('error', 'not_found');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - interval '3 minutes') then
    return jsonb_build_object('error', 'asn_offline');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - interval '3 minutes' and relay.setup_version_ok(version)) then
    return jsonb_build_object('error', 'asn_outdated');
  end if;
  perform pg_advisory_xact_lock(hashtext('setup_request:' || p_user::text));
  select * into v_r from relay.setup_requests where node = p_node for update;
  if found and ((v_r.status = 'pending' and v_r.requested_at > now() - interval '10 minutes')
             or (v_r.status = 'taken' and v_r.updated_at > now() - interval '40 minutes')) then
    return jsonb_build_object('ok', true, 'already', true, 'state', v_r.status);
  end if;
  if found and v_r.status = 'failed' and v_r.updated_at > now() - interval '1 minute' then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  if (select count(*) from relay.account_events where user_id = p_user and event = 'setup_requested' and at > now() - interval '1 hour') >= 6 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.setup_requests (node, requested_by, kind, status, detail, replaced, requested_at, updated_at)
    values (p_node, p_user, 'claude', 'pending', null, null, now(), now())
  on conflict (node) do update
    set requested_by = excluded.requested_by, kind = 'claude', status = 'pending', detail = null, replaced = null,
        requested_at = excluded.requested_at, updated_at = excluded.updated_at;
  insert into relay.account_events (user_id, event, node) values (p_user, 'setup_requested', p_node);
  return jsonb_build_object('ok', true, 'already', false, 'state', 'pending');
end;
$function$;

create or replace function public.asn_relay_setup_poll(p_node text, p_version text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_r relay.setup_requests%rowtype;
begin
  -- 過期的 pending 直接清掉；taken 太久沒回報的標成失敗，讓手機看得到
  delete from relay.setup_requests where node = p_node and status = 'pending' and requested_at <= now() - interval '10 minutes';
  update relay.setup_requests set status = 'failed', detail = '電腦沒有回報結果，已逾時', updated_at = now()
    where node = p_node and status = 'taken' and updated_at <= now() - interval '40 minutes';
  -- 版本不夠新的 ASN 看不懂這個功能，不交給它（請求留著，等夠新的視窗來取，或 10 分鐘後過期）
  if not relay.setup_version_ok(p_version) then
    return jsonb_build_object('requested', false);
  end if;
  select * into v_r from relay.setup_requests where node = p_node for update;
  if not found or v_r.status <> 'pending' then
    return jsonb_build_object('requested', false);
  end if;
  update relay.setup_requests set status = 'taken', updated_at = now() where node = p_node;
  return jsonb_build_object('requested', true, 'requested_by', v_r.requested_by, 'kind', v_r.kind);
end;
$function$;

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

commit;
