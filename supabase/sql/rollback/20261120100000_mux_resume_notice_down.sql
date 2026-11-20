-- 回復檔（不是 migration，不會被部署；要用時人工執行）。
-- 回復 20261120100000_mux_resume_notice.sql：drop 新函式 asn_relay_mux_resume_notice。
-- 原本的 asn_relay_mux_down_notice 沒有動過，不用換回；不刪任何資料（已寄出的通知信留著）。
-- 回復之後電腦端呼叫新動作會得到錯誤（Edge 回 500 或 404），只記 log、一小時後放棄，不影響其他功能。
begin;

drop function if exists public.asn_relay_mux_resume_notice(text, integer, integer, text[]);

commit;
