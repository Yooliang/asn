-- 退回 20261031110000_acct_login_alert_notify.sql：拿掉登入失效通知的寄信函式。已寄出的信不受影響。
begin;
drop function if exists public.asn_relay_login_alert(text, text, timestamptz, text, integer);
commit;
