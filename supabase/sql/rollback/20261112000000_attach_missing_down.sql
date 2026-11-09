-- 20261112000000_attach_missing.sql 的回復檔（不是 migration，不會被部署；要用時人工執行）。
-- 回復後 Edge 找不到 asn_relay_attach_missing 會自動退回舊行為（寄信照常，不提示缺件）。
begin;
drop function if exists public.asn_relay_attach_missing(text, uuid[], uuid);
commit;
