-- F4（#423）後續：asn_relay_set_legacy_env 改成「清單有變、或距上次寫入超過一小時」才寫。
-- 原因：relay 函式名單分支每次名單回報（約每分鐘）都會呼叫它，原本每次都更新 relay.nodes 那一列（20261028230000_legacy_env.sql）。
-- 清單通常不會變，每分鐘一筆寫入沒有意義；used_legacy_env_at 改成「最多晚一小時」的最後確認時間，報表用來看「最近還有沒有在用舊名」已足夠。
-- 回傳值：
--   寫入了：{ ok: true, count }（同原本）
--   不用寫（清單一樣、一小時內寫過）：{ ok: true, count, skipped: true }
--   節點不存在或不是 active：{ error: 'forbidden' }（同原本）
-- relay 函式（_shared/legacy_env.ts）只看有沒有 error，多一個 skipped 欄位不影響。
-- 只換函式本體，不動欄位與資料。回復：supabase/sql/rollback/20261029000000_legacy_env_throttle_down.sql。
begin;

create or replace function public.asn_relay_set_legacy_env(p_node text, p_names text[])
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_names text[];
begin
  select coalesce(array_agg(s.n order by s.n collate "C"), '{}'::text[]) into v_names
    from (
      select d.n from (
        select distinct u.n from unnest(coalesce(p_names, '{}'::text[])) as u(n)
          where u.n ~ '^IRORI_[A-Z0-9_]{1,64}$'
      ) d
      order by d.n collate "C"
      limit 64
    ) s;
  -- 先試著寫（只有清單有變、從沒寫過、或超過一小時才會改到那一列）；沒改到再分辨是「不用寫」還是「不能寫」。
  -- 先寫後查：節點若在兩步之間被停用，查的那一步會回 forbidden，不會誤回 ok。
  update relay.nodes set used_legacy_env = v_names, used_legacy_env_at = now()
    where id = p_node and status = 'active'
      and (used_legacy_env is distinct from v_names
           or used_legacy_env_at is null
           or used_legacy_env_at < now() - interval '1 hour');
  if found then
    return jsonb_build_object('ok', true, 'count', cardinality(v_names));
  end if;
  if not exists (select 1 from relay.nodes n where n.id = p_node and n.status = 'active') then
    return jsonb_build_object('error', 'forbidden');
  end if;
  return jsonb_build_object('ok', true, 'count', cardinality(v_names), 'skipped', true);
end;
$function$;

revoke all on function public.asn_relay_set_legacy_env(text, text[]) from public, anon, authenticated;
grant execute on function public.asn_relay_set_legacy_env(text, text[]) to service_role;

commit;
