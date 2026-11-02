-- 退回 20261101100000_inbox_hold_until.sql：拿掉設定函式與欄位（欄位裡的值只是暫存的提示，丟掉不影響其他功能）。
begin;
drop function if exists public.asn_relay_set_inbox_hold(text, timestamptz, text, integer, boolean);
alter table relay.nodes drop column if exists inbox_hold_until;
commit;
