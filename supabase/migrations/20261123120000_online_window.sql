-- 後台「在線門檻」收成單一定義（#2161 第 1 段／機械收斂）。
-- 目的：目前後台有效的函式裡有 18 個、31 處把「在線門檻」直接寫成 3 分鐘的時間字面量。
--   新增 relay.online_window()（回傳 interval，現值 3 分鐘），讓這些函式改引用它；之後要調門檻只改這一處。
-- 行為完全不變：門檻仍是 3 分鐘；函式只把「在線門檻」的 3 分鐘字面量換成 relay.online_window()，其餘（security definer、
--   set search_path to ''、volatility、參數與預設值、回傳型別、授權）一字不動。語意不同、數字剛好也是 3 分鐘的地方不換，仍是字面量（其中 push_targets、acct_expire 整支完全不動）：
--   - asn_relay_push_targets：p.fg_at（手機前景 3 分鐘內不推播）×2
--   - asn_relay_launch（7 參數與 9 參數兩版）、asn_relay_partner_op：done_at（剛開好的窗）各 1 處，共 3 處
--   - asn_relay_acct_expire：created_at（切換帳號請求 3 分鐘沒人取走就逾時）×1
-- relay.online_window() 本體的 3 分鐘字面量行尾標 -- online-window-definition（守門測試只放行這一行）。
-- 本 migration 由腳本從「套完全部既有 migration 的資料庫」取各函式的 pg_get_functiondef 產生，不是手改；等價性由 tests/online_window_sql.test.mjs 實跑證明。
-- 授權：create or replace 不動既有授權；relay.online_window() 不是 security definer，撤掉 public／anon／authenticated，只給 service_role
--   （呼叫它的函式都是 security definer，以擁有者身分執行，不靠這個授權）。
-- 回復：supabase/sql/rollback/20261123120000_online_window_down.sql（把這些函式換回字面量定義，最後 drop function relay.online_window()）。
begin;

create or replace function relay.online_window() returns interval
 language sql immutable set search_path to ''
as $function$
  select interval '3 minutes'  -- online-window-definition
$function$;
revoke all on function relay.online_window() from public, anon, authenticated;
grant execute on function relay.online_window() to service_role;

-- asn_cloud_node_list(uuid)（原定義：20261022050000_cloud_agent_invite.sql）
CREATE OR REPLACE FUNCTION public.asn_cloud_node_list(p_user uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id, 'name', n.name, 'created_at', n.created_at, 'last_seen_at', n.last_seen_at,
    'online', coalesce(n.last_seen_at > now() - relay.online_window(), false)) order by n.created_at), '[]'::jsonb)
  from relay.nodes n
  where n.owner_user = p_user and n.status = 'active' and n.created_via = 'cloud-invite';
$function$;

-- asn_relay_acct_list(text,text,uuid)（原定義：20261024130000_acct_switch_signed.sql）
CREATE OR REPLACE FUNCTION public.asn_relay_acct_list(p_actor text, p_node text, p_signed_user uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_t uuid;
  v_a jsonb;
  v_at timestamptz;
  v_online boolean;
begin
  select tenant_id into v_t from relay.nodes
    where id = p_actor and status = 'active'
      and (role = 'owner' or public.asn_user_owns_node(p_signed_user, p_actor));
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active' and tenant_id is not distinct from v_t) then
    return jsonb_build_object('error', 'not_found');
  end if;
  select accounts, updated_at into v_a, v_at from relay.asn_accounts where node = p_node;
  select exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - relay.online_window()) into v_online;
  return jsonb_build_object('node', p_node, 'accounts', coalesce(v_a, '[]'::jsonb), 'reported_at', v_at, 'asn_online', v_online);
end;
$function$;

-- asn_relay_acct_switch(text,text,text,text,uuid)（原定義：20261026200000_acct_vendor_grok.sql）
CREATE OR REPLACE FUNCTION public.asn_relay_acct_switch(p_actor text, p_node text, p_vendor text, p_email text, p_signed_user uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_t uuid;
  v_topic text;
  v_id uuid;
  v_signed boolean := public.asn_user_owns_node(p_signed_user, p_actor);
begin
  select tenant_id into v_t from relay.nodes
    where id = p_actor and status = 'active'
      and (role = 'owner' or v_signed);
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select bell_topic into v_topic from relay.nodes where id = p_node and status = 'active' and tenant_id is not distinct from v_t;
  if v_topic is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_vendor is null or p_vendor not in ('claude', 'grok') then
    return jsonb_build_object('error', 'bad_vendor');
  end if;
  if not public.asn_relay_acct_email_ok(p_email) then
    return jsonb_build_object('error', 'bad_email');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - relay.online_window()) then
    return jsonb_build_object('error', 'asn_offline');
  end if;
  if not exists (select 1 from relay.asn_accounts a, jsonb_array_elements(a.accounts) e where a.node = p_node and e->>'vendor' = p_vendor and e->>'email' = p_email) then
    return jsonb_build_object('error', 'unknown_account');
  end if;
  perform public.asn_relay_acct_expire();
  if exists (select 1 from relay.account_switches where node = p_node and status in ('pending', 'taken')) then
    return jsonb_build_object('error', 'busy');
  end if;
  if (select count(*) from relay.account_switches where node = p_node and created_at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.account_switches (tenant_id, requested_by, node, vendor, email, signed)
    values (v_t, p_actor, p_node, p_vendor, p_email, v_signed) returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

-- asn_relay_inbox_watch(boolean)（原定義：20261119200000_web_sessions.sql）
CREATE OR REPLACE FUNCTION public.asn_relay_inbox_watch(p_send boolean DEFAULT false)
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

-- asn_relay_launch(text,text,text,text,text,text,uuid)（原定義：20261023040000_asn_relay_rename.sql）
CREATE OR REPLACE FUNCTION public.asn_relay_launch(p_actor text, p_node text, p_profile text, p_name text, p_cwd text, p_first text, p_signed_user uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_l jsonb;
  v_topic text;
  v_max int;
  v_id uuid;
  v_t uuid;
begin
  select tenant_id into v_t from relay.nodes
    where id = p_actor and status = 'active'
      and (role = 'owner' or public.asn_user_owns_node(p_signed_user, p_actor));
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select launcher, bell_topic into v_l, v_topic from relay.nodes
    where id = p_node and status = 'active' and tenant_id is not distinct from v_t;
  if v_topic is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_l is null then
    return jsonb_build_object('error', 'no_launcher');
  end if;
  if not public.asn_relay_launch_name_ok(p_name) then
    return jsonb_build_object('error', 'bad_name');
  end if;
  if p_profile is null or not exists (select 1 from jsonb_array_elements(v_l->'profiles') p where p->>'id' = p_profile) then
    return jsonb_build_object('error', 'bad_profile');
  end if;
  if p_cwd is null or not exists (select 1 from jsonb_array_elements_text(v_l->'cwd_allow') c where c = p_cwd) then
    return jsonb_build_object('error', 'bad_cwd');
  end if;
  if p_first is not null and char_length(p_first) > 4000 then
    return jsonb_build_object('error', 'bad_first_message');
  end if;
  if exists (select 1 from relay.roster where node = p_node and lower(name) = lower(p_name) and seen_at > now() - relay.online_window())
     or exists (select 1 from relay.launches where node = p_node and lower(name) = lower(p_name)
                and (status in ('pending', 'taken') and created_at > now() - interval '10 minutes'
                     or status in ('ok', 'unconfirmed') and done_at > now() - interval '3 minutes')) then
    return jsonb_build_object('error', 'name_taken');
  end if;
  v_max := coalesce((v_l->>'max_per_hour')::int, 6);
  if (select count(*) from relay.launches where node = p_node and created_at > now() - interval '1 hour') >= v_max then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.launches (requested_by, node, profile, name, cwd, first_message, tenant_id)
    values (p_actor, p_node, p_profile, p_name, p_cwd, nullif(p_first, ''), v_t)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

-- asn_relay_launch(text,text,text,text,text,text,uuid,text,text)（原定義：20261028160000_launch_pi_model.sql）
CREATE OR REPLACE FUNCTION public.asn_relay_launch(p_actor text, p_node text, p_profile text, p_name text, p_cwd text, p_first text, p_signed_user uuid, p_pi_provider text, p_pi_model text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_l jsonb;
  v_topic text;
  v_max int;
  v_id uuid;
  v_t uuid;
begin
  select tenant_id into v_t from relay.nodes
    where id = p_actor and status = 'active'
      and (role = 'owner' or public.asn_user_owns_node(p_signed_user, p_actor));
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select launcher, bell_topic into v_l, v_topic from relay.nodes
    where id = p_node and status = 'active' and tenant_id is not distinct from v_t;
  if v_topic is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_l is null then
    return jsonb_build_object('error', 'no_launcher');
  end if;
  if not public.asn_relay_launch_name_ok(p_name) then
    return jsonb_build_object('error', 'bad_name');
  end if;
  if p_profile is null or not exists (select 1 from jsonb_array_elements(v_l->'profiles') p where p->>'id' = p_profile) then
    return jsonb_build_object('error', 'bad_profile');
  end if;
  if p_cwd is null or not exists (select 1 from jsonb_array_elements_text(v_l->'cwd_allow') c where c = p_cwd) then
    return jsonb_build_object('error', 'bad_cwd');
  end if;
  if p_first is not null and char_length(p_first) > 4000 then
    return jsonb_build_object('error', 'bad_first_message');
  end if;
  -- 經 pi 的提供者與模型（D2）：兩個都給或都不給；格式照 piModelWire（英數開頭，之後英數與 . _ -，最多 50 字）
  if (p_pi_provider is null) <> (p_pi_model is null)
     or (p_pi_provider is not null and (p_pi_provider !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$' or p_pi_model !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$')) then
    return jsonb_build_object('error', 'bad_pi_model');
  end if;
  if exists (select 1 from relay.roster where node = p_node and lower(name) = lower(p_name) and seen_at > now() - relay.online_window())
     or exists (select 1 from relay.launches where node = p_node and lower(name) = lower(p_name)
                and (status in ('pending', 'taken') and created_at > now() - interval '10 minutes'
                     or status in ('ok', 'unconfirmed') and done_at > now() - interval '3 minutes')) then
    return jsonb_build_object('error', 'name_taken');
  end if;
  v_max := coalesce((v_l->>'max_per_hour')::int, 6);
  if (select count(*) from relay.launches where node = p_node and created_at > now() - interval '1 hour') >= v_max then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.launches (requested_by, node, profile, name, cwd, first_message, tenant_id, pi_provider, pi_model)
    values (p_actor, p_node, p_profile, p_name, p_cwd, nullif(p_first, ''), v_t, p_pi_provider, p_pi_model)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

-- asn_relay_launchers(text,uuid[],uuid)（原定義：20261028120000_node_platform.sql）
CREATE OR REPLACE FUNCTION public.asn_relay_launchers(p_actor text, p_ids uuid[], p_signed_user uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_mach jsonb; v_recent jsonb; v_t uuid;
begin
  select tenant_id into v_t from relay.nodes
    where id = p_actor and status = 'active'
      and (role = 'owner' or public.asn_user_owns_node(p_signed_user, p_actor));
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'node', n.id, 'name', n.name, 'machine', n.machine, 'launcher', n.launcher, 'launcher_at', n.launcher_at,
      'platform', n.platform, 'launch_closed_reason', n.launch_closed_reason,
      'online', coalesce(n.last_seen_at > now() - relay.online_window(), false)) order by n.id), '[]'::jsonb)
    into v_mach from relay.nodes n
    where n.status = 'active' and (n.launcher is not null or n.platform is not null or n.launch_closed_reason is not null)
      and n.tenant_id is not distinct from v_t;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'node', l.node, 'profile', l.profile, 'name', l.name, 'cwd', l.cwd,
      'status', case when l.status = 'pending' and l.created_at <= now() - interval '2 minutes' then 'failed' else l.status end,
      'detail', case when l.status = 'pending' and l.created_at <= now() - interval '2 minutes'
                     then '機器橋 2 分鐘內沒有取走（電腦可能沒開或橋沒在跑）' else l.detail end,
      'created_at', l.created_at, 'done_at', l.done_at) order by l.created_at desc), '[]'::jsonb)
    into v_recent from (
      select * from relay.launches
      where tenant_id is not distinct from v_t
        and ((p_ids is null and created_at > now() - interval '7 days') or id = any(p_ids))
      order by created_at desc limit 30
    ) l;
  return jsonb_build_object('machines', v_mach, 'launches', v_recent);
end;
$function$;

-- asn_relay_list(uuid,boolean)（原定義：20261119200000_web_sessions.sql）
CREATE OR REPLACE FUNCTION public.asn_relay_list(p_tenant uuid, p_include_web boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id, 'name', n.name, 'kind', n.kind, 'machine', n.machine,
    'online', coalesce(n.last_seen_at > now() - relay.online_window(), false),
    'presence', case when n.last_seen_at > now() - relay.online_window() then 'live'
                     when n.last_seen_at > now() - interval '24 hours' then 'recent' else 'idle' end,
    'last_seen_at', n.last_seen_at,
    'last_active_at', n.last_active_at,
    'claude_mod', case when n.claude_mod is null then null else n.claude_mod || jsonb_build_object('updated_at', n.claude_mod_at) end,
    'avatar_updated_at', case when n.avatar is null then null else n.avatar_updated_at end,
    'archived_keys', coalesce((select jsonb_agg(a.key order by a.key) from relay.partner_archives a
                                where a.tenant_id is not distinct from p_tenant and a.node = n.id), '[]'::jsonb),
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', r.status, 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail, 'context_pct', r.context_pct, 'mod_loaded', r.mod_loaded,
        'kind', r.kind, 'receivable', r.receivable, 'model', r.model, 'hidden', r.hidden, 'elevated', r.elevated,
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'online', true,
        'last_active_at', (select p.last_active_at from relay.partners p where p.node = n.id and p.current_name = r.name),
        'avatar_updated_at', (select case when p.avatar is null then null else p.avatar_updated_at end from relay.partners p where p.node = n.id and p.current_name = r.name),
        'archived', exists (select 1 from relay.partner_archives a where a.tenant_id is not distinct from p_tenant
                              and (a.key = 'n:' || n.id || '/' || r.name
                                   or a.key = (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name)))) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at > now() - relay.online_window()
    ), '[]'::jsonb),
    'offline_agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', 'offline', 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail, 'context_pct', r.context_pct, 'mod_loaded', r.mod_loaded,
        'kind', r.kind, 'receivable', r.receivable, 'model', r.model, 'hidden', r.hidden, 'elevated', r.elevated,
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'online', false,
        'last_active_at', (select p.last_active_at from relay.partners p where p.node = n.id and p.current_name = r.name),
        'avatar_updated_at', (select case when p.avatar is null then null else p.avatar_updated_at end from relay.partners p where p.node = n.id and p.current_name = r.name),
        'last_seen_at', r.seen_at,
        'archived', exists (select 1 from relay.partner_archives a where a.tenant_id is not distinct from p_tenant
                              and (a.key = 'n:' || n.id || '/' || r.name
                                   or a.key = (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name)))) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at <= now() - relay.online_window() and r.seen_at > now() - interval '30 days'
    ), '[]'::jsonb),
    'asn', coalesce((
      select jsonb_agg(jsonb_build_object('window_name', p.window_name, 'version', p.version, 'status', p.status, 'psm', p.psm, 'updated_at', p.updated_at) order by p.window_name)
      from relay.asn_presence p where p.node = n.id and p.updated_at > now() - relay.online_window()
    ), '[]'::jsonb)) order by n.id), '[]'::jsonb)
  from relay.nodes n where n.status = 'active' and n.tenant_id is not distinct from p_tenant
    and (coalesce(p_include_web, false) or coalesce(n.kind, '') <> 'web');
$function$;

-- asn_relay_partner_archive(text,uuid,text,text,text,boolean)（原定義：20261023040000_asn_relay_rename.sql）
CREATE OR REPLACE FUNCTION public.asn_relay_partner_archive(p_actor text, p_signed_user uuid, p_node text, p_name text, p_partner_id text, p_archived boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_t uuid;
  v_key text;
  v_name text := p_name;
  v_offline boolean;
begin
  if p_archived is null or p_node is null
     or (p_partner_id is not null and p_partner_id !~ '^p_[0-9a-f]{20}$')
     or (p_partner_id is null and (p_name is null or char_length(p_name) not between 1 and 80)) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select tenant_id into v_t from relay.nodes
    where id = p_actor and status = 'active' and public.asn_user_owns_node(p_signed_user, p_actor);
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active' and tenant_id is not distinct from v_t
                   and public.asn_user_owns_node(p_signed_user, p_node)) then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_partner_id is not null then
    -- 夥伴 ID：必須是這個租戶、這個節點上的夥伴；名字以夥伴現在的為準（沒有現名就用最近的舊名）
    select coalesce(p.current_name, (select n.name from relay.partner_names n where n.partner_id = p.partner_id order by n.renamed_at desc limit 1))
      into v_name from relay.partners p
      where p.partner_id = p_partner_id and p.node = p_node and p.tenant_id is not distinct from v_t;
    if not found or v_name is null then
      return jsonb_build_object('error', 'not_found');
    end if;
    v_key := p_partner_id;
  else
    -- 沒帶夥伴 ID：名字若對得上這台的夥伴就用它的 ID（名單是用夥伴 ID 比對的），都對不上才用「節點＋名字」
    select p.partner_id into v_key from relay.partners p
      where p.node = p_node and p.current_name = p_name and p.tenant_id is not distinct from v_t limit 1;
    if v_key is null then
      v_key := 'n:' || p_node || '/' || p_name;
    end if;
  end if;
  if v_name ~ '收發室$' or exists (select 1 from relay.roster where node = p_node and name = v_name and engine = 'asn') then
    return jsonb_build_object('error', 'protected');
  end if;
  if not p_archived then
    delete from relay.partner_archives where tenant_id is not distinct from v_t and key = v_key;
    return jsonb_build_object('ok', true, 'archived', false);
  end if;
  if p_partner_id is null and not exists (select 1 from relay.roster where node = p_node and name = p_name) then
    return jsonb_build_object('error', 'not_found');
  end if;
  if (select count(*) from relay.partner_archives where tenant_id is not distinct from v_t) >= 500
     and not exists (select 1 from relay.partner_archives where tenant_id is not distinct from v_t and key = v_key) then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  v_offline := not exists (select 1 from relay.roster where node = p_node and name = v_name and seen_at > now() - relay.online_window());
  insert into relay.partner_archives (tenant_id, key, node, name, was_offline, archived_by)
    values (v_t, v_key, p_node, v_name, v_offline, p_actor)
    on conflict (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
    do update set was_offline = excluded.was_offline, archived_by = excluded.archived_by, archived_at = now(), name = excluded.name;
  return jsonb_build_object('ok', true, 'archived', true);
end;
$function$;

-- asn_relay_partner_list(uuid,text)（原定義：20261023040000_asn_relay_rename.sql）
CREATE OR REPLACE FUNCTION public.asn_relay_partner_list(p_user uuid, p_caller text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant uuid;
  v_out jsonb;
begin
  if not public.asn_user_owns_node(p_user, p_caller) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select tenant_id into v_tenant from relay.nodes where id = p_caller;
  select coalesce(jsonb_agg(x.j order by x.updated_at desc, x.pid), '[]'::jsonb) into v_out from (
    select q.pid, q.updated_at, jsonb_build_object(
        'partner_id', q.pid, 'name', q.name, 'node', q.node, 'device', q.device, 'engine', q.engine,
        'live', q.live, 'updated_at', q.updated_at) as j
    from (
      select p.partner_id as pid, p.updated_at, p.node, p.engine,
             coalesce(p.current_name, (select n.name from relay.partner_names n where n.partner_id = p.partner_id
                                         order by n.renamed_at desc limit 1)) as name,
             (select nd.name from relay.nodes nd where nd.id = p.node) as device,
             (p.current_name is not null and exists (
                select 1 from relay.roster r where r.node = p.node and r.name = p.current_name
                  and r.seen_at > now() - relay.online_window())) as live
      from relay.partners p where p.tenant_id = v_tenant
      order by p.updated_at desc, p.partner_id limit 100
    ) q where q.name is not null
  ) x;
  return jsonb_build_object('partners', v_out);
end;
$function$;

-- asn_relay_partner_op(text,uuid,text,text,text,text,text,text)（原定義：20261028210000_partner_op_resume_pi.sql）
CREATE OR REPLACE FUNCTION public.asn_relay_partner_op(p_actor text, p_signed_user uuid, p_node text, p_name text, p_op text, p_new_name text, p_model text, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_t uuid;
  v_l jsonb;
  v_topic text;
  v_id uuid;
  v_sid text;
  v_engine text;
  v_online boolean;
begin
  if p_op is null or p_op not in ('info', 'rename', 'model', 'close', 'handover', 'resume', 'restart', 'remove')
     or p_name is null or char_length(p_name) not between 1 and 80 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if p_op = 'rename' and not public.asn_relay_launch_name_ok(p_new_name) then
    return jsonb_build_object('error', 'bad_name');
  end if;
  if p_op = 'model' and (p_model is null or p_model !~ '^[A-Za-z0-9._\[\]-]{1,60}$') then
    return jsonb_build_object('error', 'bad_model');
  end if;
  if p_op = 'handover' and p_note is not null and char_length(p_note) > 1000 then
    return jsonb_build_object('error', 'bad_note');
  end if;
  -- 呼叫節點與目標節點都要是簽章者的、同租戶
  select tenant_id into v_t from relay.nodes
    where id = p_actor and status = 'active' and public.asn_user_owns_node(p_signed_user, p_actor);
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select launcher, bell_topic into v_l, v_topic from relay.nodes
    where id = p_node and status = 'active' and tenant_id is not distinct from v_t
      and public.asn_user_owns_node(p_signed_user, p_node);
  if v_topic is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_op = 'resume' then
    -- 喚醒：目標視窗已經關了（不能在名單上），用夥伴記錄裡的 session 在原本的資料夾接回同一段對話
    if p_name ~ '收發室$' then
      return jsonb_build_object('error', 'protected');
    end if;
    if exists (select 1 from relay.roster where node = p_node and lower(name) = lower(p_name) and seen_at > now() - relay.online_window()) then
      return jsonb_build_object('error', 'already_online');
    end if;
    -- 依「節點＋名字」找夥伴：目前的名字優先，其次 7 天內改掉的舊名（與寄信的解析同一套）
    select p.current_session, p.engine into v_sid, v_engine from relay.partners p
      where p.node = p_node and p.tenant_id is not distinct from v_t
        and (p.current_name = p_name
             or exists (select 1 from relay.partner_names pn where pn.partner_id = p.partner_id and pn.name = p_name and pn.renamed_at > now() - interval '7 days'))
      order by (p.current_name = p_name) desc, p.updated_at desc limit 1;
    if not found then
      return jsonb_build_object('error', 'not_found');
    end if;
    if v_engine is not null and v_engine not in ('claude', 'pi') then
      return jsonb_build_object('error', 'not_claude');
    end if;
    if v_sid is null then
      return jsonb_build_object('error', 'no_session');
    end if;
    if v_l is null then
      return jsonb_build_object('error', 'no_launcher');
    end if;
    -- 那台電腦的 ASN 要在線（節點心跳或名單 3 分鐘內有回報），不然喚醒會卡到逾時
    select coalesce(n.last_seen_at > now() - relay.online_window(), false)
           or exists (select 1 from relay.roster r where r.node = p_node and r.seen_at > now() - relay.online_window())
      into v_online from relay.nodes n where n.id = p_node;
    if not coalesce(v_online, false) then
      return jsonb_build_object('error', 'device_offline');
    end if;
  else
    -- 目標名字 3 分鐘內要在名單上
    if not exists (select 1 from relay.roster where node = p_node and name = p_name and seen_at > now() - relay.online_window()) then
      return jsonb_build_object('error', 'not_found');
    end if;
    -- 收發室與 ASN 自己的視窗不能動（電腦端執行前還會再擋一次）
    if exists (select 1 from relay.roster where node = p_node and name = p_name and engine = 'asn') or p_name ~ '收發室$' then
      return jsonb_build_object('error', 'protected');
    end if;
    -- 詳情是唯讀，不需要開放；其餘要那台電腦打開「允許遠端開視窗與管理視窗」（launcher 不為 null）
    if p_op <> 'info' and v_l is null then
      return jsonb_build_object('error', 'no_launcher');
    end if;
  end if;
  if p_op = 'rename' then
    if exists (select 1 from relay.roster where node = p_node and lower(name) = lower(p_new_name) and seen_at > now() - relay.online_window())
       or exists (select 1 from relay.partner_ops where node = p_node and op = 'rename' and lower(new_name) = lower(p_new_name)
                  and (status in ('pending', 'taken') and created_at > now() - interval '10 minutes'
                       or status in ('ok', 'unconfirmed') and done_at > now() - interval '3 minutes')) then
      return jsonb_build_object('error', 'name_taken');
    end if;
  end if;
  if exists (select 1 from relay.partner_ops where node = p_node and lower(name) = lower(p_name)
             and status in ('pending', 'taken')
             -- 未完成的操作多久之內還算「進行中」：接班換手最長會跑到 15 分鐘，所以放寬到 20 分鐘；其他動作 10 分鐘
             and created_at > now() - case when op = 'handover' then interval '20 minutes' else interval '10 minutes' end) then
    return jsonb_build_object('error', 'busy');
  end if;
  if (select count(*) from relay.partner_ops where node = p_node and created_at > now() - interval '1 hour') >= 30 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.partner_ops (tenant_id, requested_by, node, name, op, session_id, new_name, model, note)
    values (v_t, p_actor, p_node, p_name, p_op,
            case when p_op = 'resume' then v_sid end,
            case when p_op = 'rename' then p_new_name end,
            case when p_op = 'model' then p_model end,
            case when p_op = 'handover' then nullif(p_note, '') end)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

-- asn_relay_partner_succeed(uuid,text,text,text,text)（原定義：20261023040000_asn_relay_rename.sql）
CREATE OR REPLACE FUNCTION public.asn_relay_partner_succeed(p_user uuid, p_caller text, p_predecessor text, p_node text, p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_p relay.partners%rowtype;
  v_n relay.partners%rowtype;
  v_tenant uuid;
  v_a text;
  v_b text;
begin
  if p_user is null or p_predecessor is null or p_predecessor !~ '^p_[0-9a-f]{20}$'
     or p_node is null or p_name is null or char_length(p_name) not between 1 and 60 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 本人簽章：簽章的人要擁有「呼叫的節點」與「新視窗所在的節點」
  if not public.asn_user_owns_node(p_user, p_caller) or not public.asn_user_owns_node(p_user, p_node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select tenant_id into v_tenant from relay.nodes where id = p_node;

  select * into v_p from relay.partners where partner_id = p_predecessor;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_p.tenant_id is distinct from v_tenant then
    return jsonb_build_object('error', 'forbidden');
  end if;

  -- 兩個節點的同步鎖按固定順序拿（避免互等），接班期間不讓名單同步插進來
  v_a := least(p_node, v_p.node);
  v_b := greatest(p_node, v_p.node);
  perform pg_advisory_xact_lock(hashtext('partner_sync:' || v_a));
  if v_b <> v_a then
    perform pg_advisory_xact_lock(hashtext('partner_sync:' || v_b));
  end if;

  select * into v_p from relay.partners where partner_id = p_predecessor for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  select * into v_n from relay.partners where node = p_node and current_name = p_name for update;
  if not found then
    -- 新視窗還沒被 partner_sync 認進來（橋剛啟動）：請稍後再試
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_n.partner_id = v_p.partner_id then
    return jsonb_build_object('ok', true, 'partner_id', v_p.partner_id);   -- 已經是同一位（重複送出）
  end if;
  -- 前任的視窗還開著（3 分鐘內名單有它）→ 不接班，免得兩個視窗搶同一個夥伴 ID
  if v_p.current_name is not null and exists (
       select 1 from relay.roster r where r.node = v_p.node and r.name = v_p.current_name and r.seen_at > now() - relay.online_window()) then
    return jsonb_build_object('error', 'predecessor_live');
  end if;

  -- session：前任現在開著的收尾，新夥伴的 session 全部併過來（同一個 session 兩邊都有就留前任的）
  update relay.partner_sessions set ended_at = now() where partner_id = v_p.partner_id and ended_at is null;
  delete from relay.partner_sessions s where s.partner_id = v_n.partner_id
    and s.session_id in (select s2.session_id from relay.partner_sessions s2 where s2.partner_id = v_p.partner_id);
  update relay.partner_sessions set partner_id = v_p.partner_id where partner_id = v_n.partner_id;
  delete from relay.partner_sessions s
    where s.partner_id = v_p.partner_id and s.ended_at is not null and s.session_id not in (
      select s2.session_id from relay.partner_sessions s2 where s2.partner_id = v_p.partner_id
      order by s2.started_at desc, s2.session_id limit 50);
  -- 舊名字紀錄、信上的夥伴欄位都改指前任
  insert into relay.partner_names (partner_id, name, renamed_at)
    select v_p.partner_id, n.name, n.renamed_at from relay.partner_names n where n.partner_id = v_n.partner_id
    on conflict do nothing;
  update relay.messages set to_partner_id = v_p.partner_id where to_partner_id = v_n.partner_id;
  update relay.messages set from_partner_id = v_p.partner_id where from_partner_id = v_n.partner_id;
  -- 新視窗原本那筆夥伴刪掉（名字與 session 歷史已搬走），名字讓給前任
  delete from relay.partners where partner_id = v_n.partner_id;

  -- 前任原本的名字記成舊名（同節點才有意義：寄給它的信會轉到新名字）
  if v_p.current_name is not null and v_p.node = p_node and v_p.current_name <> p_name then
    insert into relay.partner_names (partner_id, name) values (v_p.partner_id, v_p.current_name);
  end if;
  update relay.partners
    set node = p_node, tenant_id = v_n.tenant_id, current_name = p_name, current_session = v_n.current_session,
        engine = coalesce(v_n.engine, engine), model = coalesce(v_n.model, model), updated_at = now()
    where partner_id = v_p.partner_id;
  insert into relay.partner_handovers (partner_id, from_node, from_name, to_node, to_name, by_user)
    values (v_p.partner_id, v_p.node, v_p.current_name, p_node, p_name, p_user);
  return jsonb_build_object('ok', true, 'partner_id', v_p.partner_id);
end;
$function$;

-- asn_relay_send_core(text,text,text,text,text,uuid,boolean,uuid,boolean)（原定義：20261119200000_web_sessions.sql）
CREATE OR REPLACE FUNCTION public.asn_relay_send_core(p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid, p_expects_reply boolean DEFAULT NULL::boolean, p_signed_user uuid DEFAULT NULL::uuid, p_as_person boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_topic text;
  v_id uuid;
  v_recent int;
  v_tenant uuid;
  v_to text := p_to_node;
  v_signed boolean := public.asn_user_owns_node(p_signed_user, p_from_node);
  v_owner uuid;
  v_alias text;
  v_person boolean := false;
  v_from_agent text := p_from_agent;
  v_person_user uuid := null;
  v_targets jsonb;
  v_phones jsonb;
  v_t jsonb;
  v_bells text[] := array[]::text[];
  v_head uuid;
  v_n int := 0;
begin
  if p_body is null or char_length(p_body) < 1 or char_length(p_body) > 20000 then
    return jsonb_build_object('error', 'bad_body');
  end if;
  select tenant_id into v_tenant from relay.nodes where id = p_from_node;
  select owner_user into v_owner from relay.tenants where id = v_tenant;
  v_alias := public.asn_person_alias(v_owner);
  -- 舊寫法相容：Irori 時代的角色節點 XISU 已拿掉。節點不存在時，寄給「XISU」「XISU/u:xxxx」（沒指定視窗或指定本人代號）一律視同寄給本人位址。
  if p_to_node = 'XISU' and not exists (select 1 from relay.nodes where id = 'XISU')
     and (p_to_agent is null or p_to_agent = '' or p_to_agent ~ '^u:[0-9a-f]{12}$') then
    if v_alias is null then
      return jsonb_build_object('error', 'unknown_to_node');
    end if;
    p_to_node := v_alias;
  end if;

  -- 與節點無關的本人位址：to_node 直接寫人代號（例如 u:3cda66252c34）。只認這個租戶擁有者的代號；
  -- 視同「寄給人代號」，後面走同一條扇出。舊寫法「節點/u:xxx」（含 XISU/u:xxx）不經過這裡，照舊可用。
  if p_to_node ~ '^u:[0-9a-f]{12}$' then
    if v_alias is null or p_to_node <> v_alias then
      return jsonb_build_object('error', 'unknown_to_node');
    end if;
    p_to_agent := v_alias;
    select coalesce(
        (select t.character_node from relay.tenants t where t.id = v_tenant),
        (select o.id from relay.nodes o where o.tenant_id = v_tenant and o.role = 'owner' and o.status = 'active' limit 1),
        (select n.id from relay.nodes n where n.tenant_id = v_tenant and n.status = 'active' and n.owner_user = v_owner and coalesce(n.kind, '') <> 'web' order by n.created_at limit 1))
      into v_to;
  end if;

  -- 保底（角色節點不再當本人的信箱）：寄給租戶「本人的角色節點」（租戶主節點 role=owner，或租戶設定的角色節點，例如 XISU）、
  -- 且沒指定視窗（或指定的就是本人代號），而那個節點上沒有在線的 ASN 視窗 → 一律改寄本人位址，照常扇出到本人各 ASN 視窗。
  -- 舊用戶端（舊橋、舊外掛、舊 AI 技能）照舊信頭只寫節點代號回信時也到得了本人。
  -- 不動的情形：指定了別的視窗名、節點上有在線的 ASN（那是真的設備）、寄件人就是該節點自己、不同租戶。
  if v_alias is not null and v_owner is not null
     and (p_to_agent is null or p_to_agent = '' or p_to_agent = v_alias)
     and v_to is distinct from p_from_node
     and exists (
       select 1 from relay.nodes rn
       where rn.id = v_to and rn.tenant_id = v_tenant and rn.status = 'active'
         and (rn.role = 'owner' or rn.id = (select t.character_node from relay.tenants t where t.id = v_tenant)))
     and not exists (
       select 1 from relay.asn_presence ap
       where ap.node = v_to and ap.updated_at > now() - relay.online_window()) then
    p_to_agent := v_alias;
  end if;

  -- 以「人」寄出：要有效的本人簽章、簽章的人就是租戶擁有者；收件人若是同帳號的 ASN 視窗（設備互聊）仍用原本的視窗名
  if coalesce(p_as_person, false) and v_signed and v_owner is not null and p_signed_user = v_owner
     and p_to_agent is distinct from v_alias
     and not exists (select 1 from relay.asn_presence ap where ap.node = v_to and ap.window_name = p_to_agent) then
    v_person := true;
    v_from_agent := v_alias;
    v_person_user := v_owner;
  end if;

  select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
    where from_node = p_from_node and created_at > now() - interval '1 minute';

  if p_reply_to is not null and not exists (
    select 1 from relay.messages where id = p_reply_to and tenant_id is not distinct from v_tenant
  ) then
    p_reply_to := null;
  end if;

  -- 寄給人代號（AI 回信）：扇出給此帳號每個在線的 ASN 視窗
  if not v_person and v_owner is not null and p_to_agent = v_alias then
    if v_recent >= 30 then
      return jsonb_build_object('error', 'rate_limited');
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('node', t.node, 'agent', t.window_name, 'bell', t.bell_topic)
             order by t.is_first desc, t.updated_at desc, t.node, t.window_name), '[]'::jsonb)
      into v_targets
      from (
        select p.node, p.window_name, n.bell_topic, p.updated_at, (p.node = v_to) as is_first
        from relay.asn_presence p join relay.nodes n on n.id = p.node
        where n.tenant_id = v_tenant and n.status = 'active' and n.owner_user = v_owner
          and coalesce(n.kind, '') <> 'web'
          and p.updated_at > now() - relay.online_window()
        order by (p.node = v_to) desc, p.updated_at desc, p.node, p.window_name
        limit 10
      ) t;
    -- 手機沒開 App 時也留一列，開 App 照一般信收到、算未讀。只認回報過平台的手機（認不出來的照舊），30 天內開過才算，積信有上限
    select coalesce(jsonb_agg(jsonb_build_object('node', t.node, 'agent', t.window_name, 'bell', t.bell_topic) order by t.node), '[]'::jsonb)
      into v_phones
      from (
        select distinct on (p.node) p.node, p.window_name, n.bell_topic
        from relay.asn_presence p join relay.nodes n on n.id = p.node
        where n.tenant_id = v_tenant and n.status = 'active' and n.owner_user = v_owner
          and n.platform in ('android', 'ios')
          and p.updated_at > now() - interval '30 days'
          and not exists (select 1 from relay.asn_presence q where q.node = p.node and q.updated_at > now() - relay.online_window())
          and (select count(*) from (select 1 from relay.messages m where m.to_node = p.node and m.acked_at is null and m.to_agent is distinct from v_alias limit 100) c) < 100
        order by p.node, p.updated_at desc
        limit 5
      ) t;
    if jsonb_array_length(v_targets) = 0 then
      -- 沒有在線的 ASN：留一列（原收件節點；它不在了就挑帳號名下最早的節點），人打開 ASN 時從往來記錄補看
      select n.bell_topic, n.id into v_topic, v_to
        from relay.nodes n
        where n.tenant_id = v_tenant and n.status = 'active' and coalesce(n.kind, '') <> 'web'
          and (n.id = v_to or n.owner_user = v_owner)
        order by (n.id = v_to) desc, n.created_at limit 1;
      if v_topic is null then
        return jsonb_build_object('error', 'unknown_to_node');
      end if;
      insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply, owner_signed, person_user)
        values (p_from_node, v_from_agent, v_to, p_to_agent, p_body, p_reply_to, v_tenant, p_expects_reply, v_signed, v_owner)
        returning id into v_id;
      v_bells := array[v_topic];
      for v_t in select value from jsonb_array_elements(v_phones) loop
        update relay.messages set fanout_id = v_id where id = v_id and fanout_id is null;
        insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply, owner_signed, person_user, fanout_id)
          values (p_from_node, v_from_agent, v_t->>'node', v_t->>'agent', p_body, p_reply_to, v_tenant, p_expects_reply, v_signed, v_owner, v_id);
        if not (v_t->>'bell' = any(v_bells)) then v_bells := v_bells || (v_t->>'bell'); end if;
      end loop;
      -- 網頁走獨立路線：不影響上面「有沒有在線設備」的判斷，只是另外多留一列給開著的網頁
      for v_t in select value from jsonb_array_elements(relay.web_lane_targets(v_tenant, v_owner, p_from_node)) loop
        update relay.messages set fanout_id = v_id where id = v_id and fanout_id is null;
        insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply, owner_signed, person_user, fanout_id)
          values (p_from_node, v_from_agent, v_t->>'node', 'web', p_body, p_reply_to, v_tenant, p_expects_reply, v_signed, v_owner, v_id);
        if not (v_t->>'bell' = any(v_bells)) then v_bells := v_bells || (v_t->>'bell'); end if;
      end loop;
      return jsonb_build_object('id', v_id, 'bell_topic', v_topic, 'bell_topics', to_jsonb(v_bells), 'fanout', 0);
    end if;
    v_targets := v_targets || v_phones;
    for v_t in select value from jsonb_array_elements(v_targets) loop
      insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply, owner_signed, person_user, fanout_id)
        values (p_from_node, v_from_agent, v_t->>'node', v_t->>'agent', p_body, p_reply_to, v_tenant, p_expects_reply, v_signed, v_owner, v_head)
        returning id into v_id;
      if v_head is null then
        v_head := v_id;
        update relay.messages set fanout_id = v_head where id = v_head;
      end if;
      v_n := v_n + 1;
      if not (v_t->>'bell' = any(v_bells)) then v_bells := v_bells || (v_t->>'bell'); end if;
    end loop;
    -- 網頁走獨立路線：不進上面的分送名單，不當頭一列，也不算進 fanout
    for v_t in select value from jsonb_array_elements(relay.web_lane_targets(v_tenant, v_owner, p_from_node)) loop
      insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply, owner_signed, person_user, fanout_id)
        values (p_from_node, v_from_agent, v_t->>'node', 'web', p_body, p_reply_to, v_tenant, p_expects_reply, v_signed, v_owner, v_head);
      if not (v_t->>'bell' = any(v_bells)) then v_bells := v_bells || (v_t->>'bell'); end if;
    end loop;
    return jsonb_build_object('id', v_head, 'bell_topic', v_bells[1], 'bell_topics', to_jsonb(v_bells), 'fanout', v_n);
  end if;

  -- 一般寄信（與上一版相同；人寄出時多記 person_user、換寄件視窗名）
  select bell_topic into v_topic from relay.nodes
    where id = v_to and status = 'active' and tenant_id is not distinct from v_tenant;
  if v_topic is null then
    return jsonb_build_object('error', 'unknown_to_node');
  end if;
  if v_recent >= 30 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply, owner_signed, person_user)
    values (p_from_node, v_from_agent, v_to, p_to_agent, p_body, p_reply_to, v_tenant, p_expects_reply, v_signed, v_person_user)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

-- asn_setup_request(uuid,text,text,text,text,text,text,text)（原定義：20261119200000_web_sessions.sql）
CREATE OR REPLACE FUNCTION public.asn_setup_request(p_user uuid, p_node text, p_kind text DEFAULT 'claude'::text, p_payload text DEFAULT NULL::text, p_sig text DEFAULT NULL::text, p_p_node text DEFAULT NULL::text, p_mode text DEFAULT 'install'::text, p_requester_phone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_r relay.setup_requests%rowtype;
  v_j jsonb;
  v_rid text;
  v_exp numeric;
  v_device boolean := p_kind in ('codex', 'grok');
  v_phone text;
begin
  if p_kind is null or p_kind not in ('claude', 'codex', 'agy', 'grok') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 模式只有 install（安裝並登入，舊行為）與 relogin（只重新登入，不安裝）；重新登入只對 claude。舊版手機不帶＝install
  if p_mode is null or p_mode not in ('install', 'relogin') or (p_mode = 'relogin' and p_kind <> 'claude') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 不是自己的節點、或節點不存在：一律回 not_found
  if p_user is null or not exists (select 1 from relay.nodes where id = p_node and status = 'active' and owner_user = p_user) then
    return jsonb_build_object('error', 'not_found');
  end if;
  -- 手機（安卓／iOS）不能被安裝：沒有電腦那一套（asn真 清單第 2 點）。平台是空的（舊版或機器橋沒回報）照舊當電腦
  if exists (select 1 from relay.nodes where id = p_node and (platform in ('android', 'ios') or coalesce(kind, '') = 'web')) then
    return jsonb_build_object('error', 'unsupported_platform');
  end if;
  -- 裝置碼型：要有請求本文、手機的設備簽章、發起的手機（本人的、有設備公鑰）。後台只檢查格式與欄位一致
  if v_device then
    if p_payload is null or p_sig is null or p_p_node is null
       or char_length(p_payload) > 1024 or p_sig !~ '^[A-Za-z0-9_-]{86}$' or p_p_node !~ '^[A-Za-z0-9_-]{1,32}$' then
      return jsonb_build_object('error', 'bad_request');
    end if;
    if not exists (select 1 from relay.nodes where id = p_p_node and status = 'active' and owner_user = p_user)
       or not exists (select 1 from relay.device_keys where node = p_p_node) then
      return jsonb_build_object('error', 'bad_request');
    end if;
    begin
      v_j := p_payload::jsonb;
    exception when others then
      return jsonb_build_object('error', 'bad_request');
    end;
    v_rid := v_j ->> 'rid';
    if jsonb_typeof(v_j) is distinct from 'object'
       or v_j ->> 'v' is distinct from 'asn-device-login-req-v1'
       or v_j ->> 't_node' is distinct from p_node
       or v_j ->> 'p_node' is distinct from p_p_node
       or v_j ->> 'vendor' is distinct from p_kind
       or coalesce(v_rid, '') !~ '^[A-Za-z0-9_-]{22}$'
       or coalesce(v_j ->> 'p_eph_pub', '') !~ '^[A-Za-z0-9_-]{43}$'
       or jsonb_typeof(v_j -> 'exp') is distinct from 'number' then
      return jsonb_build_object('error', 'bad_request');
    end if;
    v_exp := (v_j ->> 'exp')::numeric;
    -- 到期時間要在未來、而且不超過現在＋15 分鐘（容許 60 秒時鐘誤差）
    if v_exp <= extract(epoch from now()) or v_exp > extract(epoch from now()) + 960 then
      return jsonb_build_object('error', 'bad_request');
    end if;
  elsif p_payload is not null or p_sig is not null or p_p_node is not null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - relay.online_window()) then
    return jsonb_build_object('error', 'asn_offline');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - relay.online_window() and relay.setup_kind_version_ok(version, p_kind)) then
    return jsonb_build_object('error', 'asn_outdated');
  end if;
  -- 重新登入要夠新的 ASN（0.2.27 起）：舊版看不懂，會當成安裝；不建立請求
  if p_mode = 'relogin' and not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - relay.online_window() and relay.setup_relogin_version_ok(version)) then
    return jsonb_build_object('error', 'asn_outdated');
  end if;
  perform pg_advisory_xact_lock(hashtext('setup_request:' || p_user::text));
  select * into v_r from relay.setup_requests where node = p_node for update;
  if found and ((v_r.status = 'pending' and v_r.requested_at > now() - interval '10 minutes')
             or (v_r.status = 'taken' and v_r.updated_at > now() - interval '40 minutes')) then
    -- 這台已經有進行中的請求：照舊回 already（舊版手機的行為不變），多帶那筆的種類。
    -- 裝置碼型每次都用新的 rid，所以手機看到 already 就知道不是自己這次的請求
    return jsonb_build_object('ok', true, 'already', true, 'state', v_r.status, 'kind', v_r.kind, 'mode', v_r.mode);
  end if;
  if found and v_r.status = 'failed' and v_r.updated_at > now() - interval '1 minute' then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  if (select count(*) from relay.account_events where user_id = p_user and event = 'setup_requested' and at > now() - interval '1 hour') >= 6 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  -- rid 只在列存活期間不重複：只查現存的列，同一台的請求被新請求覆蓋、或列被刪除後，舊的 rid 就不再檢查
  if v_device and exists (select 1 from relay.setup_requests where rid = v_rid) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 發出請求的手機（只有 claude 才記；要是本人名下、有效的手機節點才算，否則不記）。只活在這一次請求被電腦取走期間
  v_phone := case when p_kind = 'claude' and exists (select 1 from relay.nodes where id = p_requester_phone and status = 'active' and owner_user = p_user and platform in ('android', 'ios')) then p_requester_phone end;
  insert into relay.setup_requests (node, requested_by, kind, status, detail, replaced, requested_at, updated_at,
                                    rid, req_payload, req_sig, req_p_node, t_eph_pub, cipher, t_sig, cipher_put_at, delivered_at, expires_at, mode, requester_phone)
    values (p_node, p_user, p_kind, 'pending', null, null, now(), now(),
            case when v_device then v_rid end, case when v_device then p_payload end, case when v_device then p_sig end,
            case when v_device then p_p_node end, null, null, null, null, null,
            case when v_device then to_timestamp(v_exp) end, p_mode, v_phone)
  on conflict (node) do update
    set requested_by = excluded.requested_by, kind = excluded.kind, status = 'pending', detail = null, replaced = null,
        requested_at = excluded.requested_at, updated_at = excluded.updated_at,
        rid = excluded.rid, req_payload = excluded.req_payload, req_sig = excluded.req_sig, req_p_node = excluded.req_p_node,
        t_eph_pub = null, cipher = null, t_sig = null, cipher_put_at = null, delivered_at = null, expires_at = excluded.expires_at,
        mode = excluded.mode, requester_phone = excluded.requester_phone;
  insert into relay.account_events (user_id, event, node) values (p_user, 'setup_requested', p_node);
  return jsonb_build_object('ok', true, 'already', false, 'state', 'pending');
end;
$function$;

-- asn_update_request(uuid,text)（原定義：20261119200000_web_sessions.sql）
CREATE OR REPLACE FUNCTION public.asn_update_request(p_user uuid, p_node text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_r relay.asn_update_requests%rowtype;
begin
  -- 不是自己的節點、或節點不存在：一律 not_found（不透露別人帳號下有沒有這台）
  if p_user is null or not exists (select 1 from relay.nodes where id = p_node and status = 'active' and owner_user = p_user) then
    return jsonb_build_object('error', 'not_found');
  end if;
  if exists (select 1 from relay.nodes where id = p_node and coalesce(kind, '') = 'web') then
    return jsonb_build_object('error', 'unsupported_platform');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - relay.online_window()) then
    return jsonb_build_object('error', 'asn_offline');
  end if;
  select * into v_r from relay.asn_update_requests where node = p_node for update;
  if found and v_r.status in ('pending', 'taken') and v_r.requested_at > now() - interval '30 minutes' then
    return jsonb_build_object('ok', true, 'already', true, 'state', v_r.status);
  end if;
  if found and v_r.status = 'failed' and v_r.updated_at > now() - interval '1 minute' then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.asn_update_requests (node, requested_by, status, from_version, detail, requested_at, updated_at)
    values (p_node, p_user, 'pending', null, null, now(), now())
  on conflict (node) do update
    set requested_by = excluded.requested_by, status = 'pending', from_version = null, detail = null,
        requested_at = excluded.requested_at, updated_at = excluded.updated_at;
  insert into relay.account_events (user_id, event, node) values (p_user, 'update_requested', p_node);
  return jsonb_build_object('ok', true, 'already', false, 'state', 'pending');
end;
$function$;

-- relay.messages_resolve_partner()（原定義：20261022060000_partner_succession.sql）
CREATE OR REPLACE FUNCTION relay.messages_resolve_partner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_cur text;
begin
  begin
    if new.to_partner_id is null and new.to_agent is not null then
      new.to_partner_id := relay.partner_resolve(new.to_node, new.to_agent);
    end if;
    if new.from_partner_id is null and new.from_agent is not null then
      new.from_partner_id := relay.partner_resolve(new.from_node, new.from_agent);
    end if;
    -- 轉寄：有解析到夥伴，但這個名字現在不屬於任何夥伴、名單裡也沒有同名的在線視窗（名字還有人用就照舊）
    if new.to_partner_id is not null and new.to_agent is not null
       and not exists (select 1 from relay.partners p where p.node = new.to_node and p.current_name = new.to_agent)
       and not exists (select 1 from relay.roster r where r.node = new.to_node and r.name = new.to_agent
                       and r.seen_at > now() - relay.online_window()) then
      select p.current_name into v_cur from relay.partners p
        where p.partner_id = new.to_partner_id and p.node = new.to_node and p.current_name is not null;
      if v_cur is not null and v_cur <> new.to_agent then
        new.forwarded_from := new.to_agent;
        new.to_agent := v_cur;
      end if;
    end if;
  exception when others then
    null;
  end;
  return new;
end;
$function$;

-- relay.room_member_presence(text)（原定義：20261026300000_room_member_pi_provider.sql）
CREATE OR REPLACE FUNCTION relay.room_member_presence(p_member text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when p_member like '~%' then '{}'::jsonb
    when position('~' in p_member) > 0 then (
      select jsonb_strip_nulls(jsonb_build_object('online', coalesce(r.seen_at > now() - relay.online_window(), false), 'engine', coalesce(r.engine, case when n.kind in ('claude','gpt','gemini','grok') then n.kind end),
        'provider', case when r.engine = 'pi' and position('/' in coalesce(r.model, '')) > 1 and lower(split_part(r.model, '/', 1)) ~ '^[a-z0-9._-]{1,30}$' then lower(split_part(r.model, '/', 1)) end))
      from (select 1) d
      left join relay.roster r on r.node = split_part(p_member, '~', 1) and r.name = substr(p_member, position('~' in p_member) + 1)
      left join relay.nodes n on n.id = split_part(p_member, '~', 1))
    else (
      select jsonb_strip_nulls(jsonb_build_object('online', coalesce(n.last_seen_at > now() - relay.online_window(), false), 'engine', case when n.kind in ('claude','gpt','gemini','grok') then n.kind end))
      from (select 1) d left join relay.nodes n on n.id = p_member)
  end;
$function$;

-- relay.web_lane_targets(uuid,uuid,text)（原定義：20261119200000_web_sessions.sql）
CREATE OR REPLACE FUNCTION relay.web_lane_targets(p_tenant uuid, p_owner uuid, p_from text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('node', t.id, 'bell', t.bell_topic) order by t.id), '[]'::jsonb)
  from (
    select n.id, n.bell_topic from relay.nodes n
     where n.tenant_id = p_tenant and n.status = 'active' and n.owner_user = p_owner and n.kind = 'web' and n.id <> p_from
       and exists (select 1 from relay.asn_presence p where p.node = n.id and p.updated_at > now() - relay.online_window())
     order by n.id limit 10
  ) t;
$function$;

commit;
