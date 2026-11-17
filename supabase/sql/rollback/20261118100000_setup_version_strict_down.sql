-- 回復 20261118100000_setup_version_strict.sql：兩支函式放回上一版原文（20261102140000 的 setup_version_ok、20261113400000 的 setup_kind_version_ok）。
-- 回復後，超長版本字串（如 0.2.99999999999999）又會讓轉型溢位而丟錯。不動任何資料表。
begin;

create or replace function relay.setup_version_ok(p_version text)
 returns boolean language sql immutable set search_path to ''
as $function$
  select coalesce(p_version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}', false)
     and string_to_array(substring(p_version from '^[0-9]+\.[0-9]+\.[0-9]+'), '.')::int[] >= array[0, 2, 2];
$function$;
revoke all on function relay.setup_version_ok(text) from public, anon, authenticated;

create or replace function relay.setup_kind_version_ok(p_version text, p_kind text)
 returns boolean language sql immutable set search_path to ''
as $function$
  select relay.setup_version_ok(p_version)
     and string_to_array(substring(p_version from '^[0-9]+\.[0-9]+\.[0-9]+'), '.')::int[]
         >= case p_kind when 'claude' then array[0, 2, 2] when 'codex' then array[0, 2, 17] else array[9999, 0, 0] end;
$function$;
revoke all on function relay.setup_kind_version_ok(text, text) from public, anon, authenticated;

commit;
