-- F4（#423）：存下名單回報的 used_legacy_env（F1 舊名使用報表的環境變數部分）。
-- 用戶端在名單回報頂層送「這個節點／橋啟動時靠舊名（IRORI_*）才拿到設定的環境變數名字」，只有名字、不含值。
-- 1. relay.nodes 加兩個可為 null 的欄位：
--    used_legacy_env：最後一次回報的清單；null＝從沒回報過（舊版用戶端），'{}'＝回報了、沒用舊名。最多 64 個。
--    used_legacy_env_at：最後一次寫入這個欄位的時間。
-- 2. asn_relay_set_legacy_env：relay 函式在名單分支「有帶這個欄位才寫」（白名單過濾在 _shared/legacy_env.ts）。
--    這裡再檢查一次格式（IRORI_ 開頭、大寫英數與底線、最多 64 字）、排序去重、最多 64 個。只改自己節點。
-- 只加欄位與函式，不改舊值；新函式直接用新名，不需要 irori_relay_* 舊名包裝。
-- 部署順序：migration → relay 函式 → 用戶端（用戶端先上也不會壞：後台不認得的頂層欄位會被略過）。
begin;

alter table relay.nodes add column if not exists used_legacy_env text[];
alter table relay.nodes add column if not exists used_legacy_env_at timestamptz;
alter table relay.nodes drop constraint if exists nodes_used_legacy_env_check;
alter table relay.nodes add constraint nodes_used_legacy_env_check
  check (used_legacy_env is null or cardinality(used_legacy_env) <= 64);

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
  update relay.nodes set used_legacy_env = v_names, used_legacy_env_at = now()
    where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  return jsonb_build_object('ok', true, 'count', cardinality(v_names));
end;
$function$;

revoke all on function public.asn_relay_set_legacy_env(text, text[]) from public, anon, authenticated;
grant execute on function public.asn_relay_set_legacy_env(text, text[]) to service_role;

commit;
