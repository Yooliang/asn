-- 手機替電腦登入 Codex 開放（#933 PR-7）：Codex 種類的最低版本從 9999.0.0（還不交）改成 0.2.17。
-- 只換 relay.setup_kind_version_ok 一支函式：claude 照舊 0.2.2；codex 0.2.17；grok、agy 仍是 9999.0.0（還不交，Grok 要等驗證過的安裝上線）。
-- 版本是電腦自報的，這只是相容性閘門：0.2.16 以前的電腦端沒有 0.2.17 的手機端配套，不交給它們。真正的把關在電腦本機（驗手機簽章、本人勾選允許）。
-- 部署順序：本 migration → 發 0.2.17。提早上不會壞：0.2.17 以前的手機沒有入口，送不出 codex 請求；0.2.16 以前的電腦照舊不交。
-- 回復：supabase/sql/rollback/20261113400000_setup_device_login_codex_down.sql（改回全部非 claude 都是 9999.0.0）。
begin;

create or replace function relay.setup_kind_version_ok(p_version text, p_kind text)
 returns boolean language sql immutable set search_path to ''
as $function$
  select relay.setup_version_ok(p_version)
     and string_to_array(substring(p_version from '^[0-9]+\.[0-9]+\.[0-9]+'), '.')::int[]
         >= case p_kind when 'claude' then array[0, 2, 2] when 'codex' then array[0, 2, 17] else array[9999, 0, 0] end;
$function$;
revoke all on function relay.setup_kind_version_ok(text, text) from public, anon, authenticated;

commit;
