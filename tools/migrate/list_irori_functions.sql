-- 只讀查詢：列出線上所有 irori_relay_ 與 asn_relay_ 開頭的函式、參數型別、預設值、回傳型別、波動性、安全模式與權限。
-- 用途：#14 R6 改名 migration（20261023040000_asn_relay_rename.sql）部署前，拿這份結果對照 migration 內「改名清單」有沒有漏。
-- 在 Supabase SQL 編輯器或 psql 執行；不會改任何東西。
-- 對照方式：「簽章」欄（只含型別）必須和 migration 清單的每一列一致；線上多出來的列就是漏了，要先補進 migration。

select
  n.nspname                                   as schema,
  p.proname                                   as 函式,
  pg_get_function_identity_arguments(p.oid)   as 簽章,
  pg_get_function_arguments(p.oid)            as 含預設值的參數,
  pg_get_function_result(p.oid)               as 回傳,
  case p.provolatile when 'i' then 'immutable' when 's' then 'stable' else 'volatile' end as 波動性,
  case when p.prosecdef then 'security definer' else 'security invoker' end              as 安全模式,
  p.proconfig                                 as 設定,
  coalesce(array_to_string(p.proacl, ','), '(預設權限)') as 權限
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname like 'irori\_relay\_%' or p.proname like 'asn\_relay\_%'
order by p.proname, pg_get_function_identity_arguments(p.oid);

-- 其他結構描述的函式內容是否還呼叫舊名（改名 migration 會一併改成新名；這裡只是事先看有哪些）
select n.nspname as schema, p.proname as 函式
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.prokind = 'f'
  and p.prosrc like '%irori\_relay\_%'
  and not (n.nspname = 'public' and p.proname like 'irori\_relay\_%')
order by 1, 2;

-- 定時排程指令裡是否還有舊名（沒有安裝 pg_cron 時這段會出錯，略過即可）
select jobid, jobname, schedule
from cron.job
where command like '%irori\_relay\_%';
