-- 後台記錄特權動作「怎麼通過的」（#500 拆項 1：觀測）。只新增，不改任何既有函式、不改授權與回應。
-- 一張只累加的計數表 relay.auth_observe：每天、每個動作、每種通過方式、每種簽章狀態、每個呼叫端節點（雜湊）一列，次數累加。
--   通過方式 via：signed（本人簽章）／role（節點角色）
--   簽章狀態 sig：absent（沒帶標頭）／invalid（驗證失敗）／valid_not_owner（驗證通過但不是這個節點的擁有者）／valid_owner（驗證通過且是擁有者）
--   節點雜湊 node_hash：在 Edge 算好的 sha256 前 16 碼；表內沒有使用者 id、email、內容、金鑰欄位。
-- 寫入只走 asn_relay_auth_observe（security definer、只授權 service_role）；清理走 asn_relay_auth_observe_purge，保留 180 天，每天 03:43（UTC）由 pg_cron 執行。
-- 判斷「簽章使用者是否擁有節點」直接用既有的 public.asn_user_owns_node（唯讀、已授權 service_role），不另加包裝。
-- 部署順序：本 migration → relay／irori-relay（Edge 開始記錄）。舊 Edge 不呼叫新函式，提早套不會壞；Edge 先於 migration 時記錄失敗只寫 log、不影響回應。
-- 回復：supabase/sql/rollback/20261122100000_auth_observe_down.sql（取消排程、drop 函式與表；表內只有計數，沒有其他資料）。
begin;

create table if not exists relay.auth_observe (
  day date not null,
  action text not null check (action ~ '^[a-z_]{1,40}$'),
  via text not null check (via in ('signed', 'role')),
  sig text not null check (sig in ('absent', 'invalid', 'valid_not_owner', 'valid_owner')),
  node_hash text not null check (node_hash ~ '^[0-9a-f]{16}$'),
  n bigint not null default 0 check (n >= 0),
  primary key (day, action, via, sig, node_hash)
);
alter table relay.auth_observe enable row level security;
revoke all on relay.auth_observe from public, anon, authenticated;

-- 累加一次（日期用 UTC 今天）。參數不合格式會被資料表的檢查擋下並回錯，由後台只記 log
create or replace function public.asn_relay_auth_observe(p_action text, p_via text, p_sig text, p_node_hash text)
 returns void
 language sql
 security definer
 set search_path to ''
as $function$
  insert into relay.auth_observe as o (day, action, via, sig, node_hash, n)
  values ((now() at time zone 'utc')::date, p_action, p_via, p_sig, p_node_hash, 1)
  on conflict (day, action, via, sig, node_hash) do update set n = o.n + 1;
$function$;

-- 保留期：刪掉超過 p_days 天（預設 180）的列，回傳刪了幾列
create or replace function public.asn_relay_auth_observe_purge(p_days integer default 180)
 returns bigint
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_n bigint;
begin
  if p_days is null or p_days < 1 then
    raise exception 'bad_days';
  end if;
  delete from relay.auth_observe where day < (now() at time zone 'utc')::date - p_days;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

revoke all on function public.asn_relay_auth_observe(text, text, text, text) from public, anon, authenticated;
revoke all on function public.asn_relay_auth_observe_purge(integer) from public, anon, authenticated;
grant execute on function public.asn_relay_auth_observe(text, text, text, text) to service_role;
grant execute on function public.asn_relay_auth_observe_purge(integer) to service_role;

create extension if not exists pg_cron;
select cron.unschedule('asn-auth-observe-purge-180d') where exists (select 1 from cron.job where jobname = 'asn-auth-observe-purge-180d');
select cron.schedule('asn-auth-observe-purge-180d', '43 3 * * *', $$ select public.asn_relay_auth_observe_purge(180); $$);

commit;
