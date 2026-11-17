-- 版本比對收緊（#1681）：版本字串太長的數字（例如 0.2.99999999999999）不再讓 ::int[] 轉型溢位而丟錯，一律當作「不合格」回 false。
-- 原因：舊寫法的檢查 regex 沒有結尾錨點，取數字的 substring 也沒有位數上限；前綴通過檢查後，超過 int 範圍的數字轉型就 raise。
-- SQL 的 AND 不保證短路，setup_kind_version_ok 自己的 substring 轉型在檢查為 false 時也可能被求值而丟錯。
-- 改法：版本只接受「0~9999.0~9999.0~999999」後面接結尾或非數字（0.2.29、0.2.29-test-abc 照舊通過）；
--   取數字的 substring 用同一條有界 regex，轉型永遠不會溢位；不合格取到 null，用 coalesce 收成 false。
-- 常態版本的結果不變（0.2.29.1、0.2.29x 照舊視為 0.2.29）；只有 0.2.1234567 這種第三段超過 6 位數、或前兩段超過 4 位數的，從「通過／丟錯」變成 false。
-- 不動任何資料表、不改簽章與屬性，只換 setup_version_ok、setup_kind_version_ok 兩支函式。
-- 部署順序：只有本 migration；Edge Function、客戶端都不用改。
-- 回復：supabase/sql/rollback/20261118100000_setup_version_strict_down.sql（放回上一版函式原文）。
begin;

create or replace function relay.setup_version_ok(p_version text)
 returns boolean language sql immutable set search_path to ''
as $function$
  select coalesce(
    string_to_array(substring(p_version from '^([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6})(?![0-9])'), '.')::int[] >= array[0, 2, 2],
    false);
$function$;
revoke all on function relay.setup_version_ok(text) from public, anon, authenticated;

create or replace function relay.setup_kind_version_ok(p_version text, p_kind text)
 returns boolean language sql immutable set search_path to ''
as $function$
  select relay.setup_version_ok(p_version)
     and coalesce(
       string_to_array(substring(p_version from '^([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6})(?![0-9])'), '.')::int[]
         >= case p_kind when 'claude' then array[0, 2, 2] when 'codex' then array[0, 2, 17] else array[9999, 0, 0] end,
       false);
$function$;
revoke all on function relay.setup_kind_version_ok(text, text) from public, anon, authenticated;

commit;
