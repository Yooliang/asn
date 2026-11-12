-- 回復 20261113400000_setup_device_login_codex.sql：非 claude 的種類全部改回 9999.0.0（還不交）。
-- 已經交出去、正在跑的 codex 請求不受影響（照舊到期清掉）；之後新的 codex 請求會回 asn_outdated。
begin;

create or replace function relay.setup_kind_version_ok(p_version text, p_kind text)
 returns boolean language sql immutable set search_path to ''
as $function$
  select relay.setup_version_ok(p_version)
     and string_to_array(substring(p_version from '^[0-9]+\.[0-9]+\.[0-9]+'), '.')::int[]
         >= case p_kind when 'claude' then array[0, 2, 2] else array[9999, 0, 0] end;
$function$;
revoke all on function relay.setup_kind_version_ok(text, text) from public, anon, authenticated;

commit;
