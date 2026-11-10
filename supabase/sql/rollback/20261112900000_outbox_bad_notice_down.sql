-- 回復檔（不是 migration，不會被部署；要用時人工執行）。
-- 回復 20261112600000_outbox_bad_notice.sql：drop asn_relay_outbox_bad_notice。不刪任何資料（已寄出的通知信留著）。
begin;

drop function if exists public.asn_relay_outbox_bad_notice(text);

commit;
