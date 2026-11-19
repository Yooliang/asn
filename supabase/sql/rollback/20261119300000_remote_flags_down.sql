-- 回復 20261119300000_remote_flags.sql：拿掉函式與三個欄位（只是提示值，沒有別的東西依賴）。
begin;

drop function if exists public.asn_relay_set_remote_flags(text, boolean, boolean);
alter table relay.nodes drop column if exists remote_flags_at;
alter table relay.nodes drop column if exists remote_input;
alter table relay.nodes drop column if exists remote_view;

commit;
