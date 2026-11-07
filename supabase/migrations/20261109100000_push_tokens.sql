-- App 關著手機也要響（#797，FCM 推播）PR①：推播權杖的資料表與函式。設計見 docs/design/PUSH-FCM.md。
-- 設計（asn真 定案）：
--   * 只有手機節點（relay.nodes.platform = 'android'，0.2.1 起的手機在線回報會帶）能註冊權杖；每台一個，權杖全表唯一。
--     同一個權杖註冊到新節點時，先刪掉掛在別的節點上的（換帳號後舊帳號的信不會讓這台手機響）。
--   * 權杖只在 asn_relay_push_targets 回傳給 Edge（送 FCM 用）；註冊／取消／清除都不回傳權杖。
--   * 「要推誰」用**新函式** asn_relay_push_targets(p_user, p_kind)，不改既有的寄信函式：
--     既有函式（asn_relay_send_core、asn_relay_waiting_notice）一個字都不動，線上 Edge 完全不受影響；
--     由新版 Edge 在「寄給本人」和「夥伴在等你」兩種情況寄出之後呼叫，決定權在這裡（誰、在不在線、多久一則）。
--     第一版只收這兩種（p_kind = 'owner_mail'／'waiting'），其他回 bad_request。
--   * **p_user＝收件的那個人**，只能由 Edge 從伺服器端的結果取得，不能取自用戶端參數：
--       owner_mail：寄信函式回傳的收件人（人代號 alias 解出來的那位 user），不是寄件那台的擁有者（外部帳號寄給本人時兩者不同）；
--       waiting：asn_relay_waiting_notice 處理的那位夥伴節點的 owner_user（就是被通知的人）。
--   * 推的對象：p_user 名下、啟用中、android、有權杖、30 天內開過 App、現在不在線（3 分鐘，和 #796 同一套判斷）；
--     「30 天內開過」看權杖的 updated_at（App 每次啟動都重報權杖），**不看 asn_presence**：設成「顯示為離線」的人沒有在線列，看在線列會永遠收不到。
--     「現在不在線」＝3 分鐘內沒有任何 asn_presence 列（完全沒有列也算不在線）。
--     同一台 60 秒最多一則：update … where last_sent_at 超過 60 秒 … returning，原子判斷並同時記下送出時間。
--   * 清除：asn_relay_push_prune() 刪 60 天沒更新的，pg_cron 每天 03:51（UTC）跑一次（asn-push-tokens-prune）；asn_relay_push_invalid(p_node, p_token) 給 Edge 在 FCM 回權杖失效時刪（權杖要對得上）。
--   * 權杖格式只檢查長度和字元集，不信任內容。
-- 先不用：沒有任何舊版用戶端或 Edge 會呼叫這些函式；手機要等 PR③ 才會註冊。**等 Firebase 準備好才上正式庫。**
-- 回復：select cron.unschedule('asn-push-tokens-prune')；drop function asn_relay_push_register、asn_relay_push_unregister、asn_relay_push_targets、asn_relay_push_prune、asn_relay_push_invalid；drop table relay.push_tokens。
begin;

create table if not exists relay.push_tokens (
  node text not null,
  token text not null,
  updated_at timestamptz not null default now(),
  last_sent_at timestamptz,
  constraint push_tokens_pkey primary key (node),
  constraint push_tokens_token_key unique (token),
  constraint push_tokens_token_check check (char_length(token) between 32 and 1024 and token ~ '^[A-Za-z0-9_:-]+$'),
  constraint push_tokens_node_fkey foreign key (node) references relay.nodes(id) on delete cascade
);
alter table relay.push_tokens enable row level security;
revoke all on relay.push_tokens from public, anon, authenticated;

-- 手機註冊（節點金鑰）：換新權杖也走這裡
create or replace function public.asn_relay_push_register(p_node text, p_token text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
begin
  if p_token is null or char_length(p_token) not between 32 and 1024 or p_token !~ '^[A-Za-z0-9_:-]+$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active' and platform = 'android') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  delete from relay.push_tokens where token = p_token and node <> p_node;
  insert into relay.push_tokens (node, token) values (p_node, p_token)
    on conflict (node) do update set token = excluded.token, updated_at = now();
  return jsonb_build_object('ok', true);
end;
$function$;

-- 手機登出、換帳號、移除裝置（節點金鑰）
create or replace function public.asn_relay_push_unregister(p_node text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
begin
  delete from relay.push_tokens where node = p_node;
  return jsonb_build_object('ok', true);
end;
$function$;

-- 要推誰（新版 Edge 在寄給本人、夥伴在等你之後呼叫）。回 {targets: [{node, token}]}；這是 Edge 唯一拿到權杖的地方。
-- p_user＝收件的那個人，來源規則見檔頭（只能取自伺服器端的結果）
create or replace function public.asn_relay_push_targets(p_user uuid, p_kind text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_out jsonb;
begin
  if p_kind is null or p_kind not in ('owner_mail', 'waiting') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if p_user is null then
    return jsonb_build_object('targets', '[]'::jsonb);
  end if;
  with due as (
    select t.node
      from relay.push_tokens t join relay.nodes n on n.id = t.node
     where n.owner_user = p_user and n.status = 'active' and n.platform = 'android'
       and t.updated_at > now() - interval '30 days'
       and not exists (select 1 from relay.asn_presence p where p.node = t.node and p.updated_at > now() - interval '3 minutes')
  ), sent as (
    update relay.push_tokens t set last_sent_at = now()
      from due
     where t.node = due.node and (t.last_sent_at is null or t.last_sent_at < now() - interval '60 seconds')
    returning t.node, t.token
  )
  select coalesce(jsonb_agg(jsonb_build_object('node', node, 'token', token) order by node), '[]'::jsonb) into v_out from sent;
  return jsonb_build_object('targets', v_out);
end;
$function$;

-- 清掉 60 天沒更新的權杖（手機每次開 App 都會重報）
create or replace function public.asn_relay_push_prune()
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_n int;
begin
  delete from relay.push_tokens where updated_at < now() - interval '60 days';
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'removed', v_n);
end;
$function$;

-- FCM 回權杖失效時由 Edge 呼叫：權杖要和這台記的一樣才刪（避免刪到剛換上的新權杖）
create or replace function public.asn_relay_push_invalid(p_node text, p_token text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_n int;
begin
  delete from relay.push_tokens where node = p_node and token = p_token;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'removed', v_n > 0);
end;
$function$;

revoke all on function public.asn_relay_push_register(text, text) from public, anon, authenticated;
revoke all on function public.asn_relay_push_unregister(text) from public, anon, authenticated;
revoke all on function public.asn_relay_push_targets(uuid, text) from public, anon, authenticated;
revoke all on function public.asn_relay_push_prune() from public, anon, authenticated;
revoke all on function public.asn_relay_push_invalid(text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_push_register(text, text) to service_role;
grant execute on function public.asn_relay_push_unregister(text) to service_role;
grant execute on function public.asn_relay_push_targets(uuid, text) to service_role;
grant execute on function public.asn_relay_push_prune() to service_role;
grant execute on function public.asn_relay_push_invalid(text, text) to service_role;

-- 清理：每天 03:51（UTC）刪 60 天沒更新的權杖
create extension if not exists pg_cron;
select cron.unschedule('asn-push-tokens-prune') where exists (select 1 from cron.job where jobname = 'asn-push-tokens-prune');
select cron.schedule('asn-push-tokens-prune', '51 3 * * *', $$ select public.asn_relay_push_prune(); $$);

commit;
