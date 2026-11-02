-- 【獨立區塊】收信卡住監控（0.2.1 第一順位，asn真 #2142；起因：正見的收信程式停擺 5 天，後台一直顯示在線，沒有任何警報）。
-- 與其他 migration 分開，審查可各自看、各自回復。設計貼在群組 #2167，asn真 點頭。
--
-- 做什麼：每 5 分鐘（pg_cron）看每個「在線」節點有幾封信沒確認（relay.messages.acked_at 為空）、最舊的一封等了多久。
--   在線（relay.nodes.last_seen_at 3 分鐘內），但最舊的未確認信超過 15 分鐘 → 標成 stuck（只標記）；標成 stuck 後持續卡著超過 10 分鐘（電腦剛開機信的年齡本來就大，避免誤報）才寄一封給該節點的擁有者；
--   還卡著，每 24 小時再提醒一次；恢復（沒有未確認，或最舊的不到 5 分鐘）→ 標回 ok，寄一封「已恢復」。
--   last_seen_at 會被名單回報刷新，所以「在線」不代表收信正常——這正是要抓的情況。
-- 影子跑：函式有 p_send 參數，排程先用 false 呼叫（只更新狀態表、不寄信），對照真實資料沒問題再另開一個小 migration 把排程改成 true。
-- 不看的節點：非 active、不在線、手機節點（kind = 'phone'，只有 App 在前景才算在線）、relay.nodes.inbox_hold_until 還沒到（節點自己說「額度用完，到幾點才轉交」，
--   那段期間擁有者只會收到那邊的通知，不重複）。擁有者查不到、寄不出去的節點記警告跳過，單一節點出錯不影響其他節點。
-- 通知：沿用 asn_relay_login_alert 的做法——收件人由資料庫查節點的 owner_user，寄件人固定「收信監控收發室」（名稱以「收發室」結尾，對方不會把它當一般夥伴：轉交逾時的通知不會回寄到卡住的節點），內文由這裡套固定句型
--   （電腦名、筆數級別、最舊等了多久），不帶信的內容；每節點每小時最多 3 封；經既有的 asn_relay_send 寫一列，擁有者的視窗下次輪詢（約 2 分鐘）看到，這一版不叫鈴。
--
-- security definer 函式碰到的資料表：
--   public.asn_relay_inbox_watch(p_send boolean)  讀 relay.nodes、relay.messages；讀寫 relay.inbox_watch；
--                                                 間接：既有的 public.asn_person_alias（無資料表）、public.asn_user_owns_node（讀 relay.nodes）、
--                                                 public.asn_relay_send（寫 relay.messages，是既有函式；本函式只用它寄固定句型的通知）
--   沒有別的新函式。只授權 service_role；pg_cron 以資料庫擁有者身分呼叫。
-- 新資料表 relay.inbox_watch：RLS 開、沒有 policy、不給 public／anon／authenticated；節點刪除時跟著刪（on delete cascade）。
-- 新欄位 relay.nodes.inbox_hold_until：和 asn-2（#173）的 migration 用同一個寫法（add column if not exists），誰先合都不衝突；設定它的函式由 #173 提供。
-- 不加索引：relay.messages 已有 messages_inbox_idx (to_node, created_at) where acked_at is null，這個查詢掃的就是它，量只跟「目前沒確認的信總數」成正比。
-- 部署：本 migration（影子跑）→ 看對照結果 → 再開寄信。回復：supabase/sql/rollback/20261102130000_inbox_watch_down.sql（取消排程、drop 函式與表，欄位保留）。
begin;

alter table relay.nodes add column if not exists inbox_hold_until timestamptz;

create table if not exists relay.inbox_watch (
  node text not null,
  state text not null default 'ok',
  level text not null default '0',
  last_count integer not null default 0,
  last_oldest_at timestamptz,
  stuck_since timestamptz,
  notified_at timestamptz,
  recovered_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint inbox_watch_pkey primary key (node),
  constraint inbox_watch_node_fkey foreign key (node) references relay.nodes(id) on delete cascade,
  constraint inbox_watch_state_check check (state in ('ok', 'stuck')),
  constraint inbox_watch_level_check check (level in ('0', '1-10', '10-50', '50+'))
);
alter table relay.inbox_watch enable row level security;
revoke all on relay.inbox_watch from public, anon, authenticated;

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
  v_recent int;
  v_nodes int := 0;
  v_stuck_n int := 0;
  v_sent int := 0;
  v_res jsonb;
  v_agent constant text := '收信監控收發室';
begin
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

      if v_stuck and v_state.state = 'ok' then
        -- 第一次判成卡住只標記，不寄：電腦剛開機時信的年齡本來就大，要持續卡著一段時間才寄
        update relay.inbox_watch set state = 'stuck', stuck_since = now(), level = v_level, last_count = r.cnt, last_oldest_at = r.oldest, updated_at = now() where node = r.id;
      elsif v_stuck then
        update relay.inbox_watch set level = v_level, last_count = r.cnt, last_oldest_at = r.oldest, updated_at = now() where node = r.id;
        if v_state.notified_at is null and v_state.stuck_since <= now() - interval '10 minutes' then
          -- 標成 stuck 後持續卡著超過 10 分鐘才第一次寄（影子跑期間就標成 stuck 的，開寄信後第一輪補寄）
          v_body := v_name || ' 還在線，但有 ' || r.cnt || ' 封信沒有確認，最舊的已經等了 ' || (extract(epoch from now() - r.oldest) / 60)::int || ' 分鐘，收信可能卡住了。';
        elsif v_state.notified_at <= now() - interval '24 hours' then
          v_body := v_name || ' 的收信還是卡著：' || r.cnt || ' 封信沒有確認，最舊的已經等了 ' || (extract(epoch from now() - r.oldest) / 60)::int || ' 分鐘。';
        end if;
      elsif v_ok and v_state.state = 'stuck' then
        update relay.inbox_watch set state = 'ok', stuck_since = null, level = v_level, last_count = r.cnt, last_oldest_at = r.oldest, recovered_at = now(), notified_at = null, updated_at = now() where node = r.id;
        -- 從沒寄過「卡住」（影子跑期間就恢復了）就不寄「恢復」
        if v_state.notified_at is not null then
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
            -- 寄信放在自己的區塊：寄不出去只是這一輪沒通知（notified_at 沒記，下一輪再試），不會把前面更新好的狀態一起回復
            begin
              v_alias := public.asn_person_alias(r.owner_user);
              -- asn_relay_send 失敗是回傳 {"error": ...}，不是丟例外：要看回傳值，寄失敗不能當成寄成功
              v_res := public.asn_relay_send(r.id, v_agent, v_alias, null, v_body, null, false, null, false);
              if v_res is null or v_res ? 'error' then
                raise warning 'inbox_watch: send for node % refused: %', r.id, v_res ->> 'error';
              else
                v_sent := v_sent + 1;
                if v_stuck then
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

-- ===cron=== （排程；pglite 測試沒有 pg_cron，在這個標記處截斷。要能重跑）
create extension if not exists pg_cron;
select cron.unschedule('asn-inbox-watch') where exists (select 1 from cron.job where jobname = 'asn-inbox-watch');
select cron.schedule('asn-inbox-watch', '*/5 * * * *', $$ select public.asn_relay_inbox_watch(false); $$);

commit;
