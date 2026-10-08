-- 退回 25：拿掉 irori_relay_purge（已經刪掉的往來紀錄不會回來）。要先把 irori-api 退回不呼叫它的版本（呼叫失敗只記 log、不影響其他）。
begin;
drop function if exists public.irori_relay_purge(uuid, timestamptz);
commit;
