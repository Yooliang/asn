-- ASN 在線狀態與版本：每個 ASN 視窗每 60 秒回報一次（節點取自金鑰，只能寫自己的節點）。
-- 名單（list）在每個節點底下帶出 asn 列（updated_at 3 分鐘內才算在線），後台也能直接查有幾個 ASN 在線、各是哪一版。
-- 關閉時 ASN 回報 offline＝刪掉那一列。資料只留 90 天（沒人回報的舊列）。
begin;

create table relay.asn_presence (
  node text not null,
  window_name text not null,
  version text not null,
  status text not null,
  psm text,
  updated_at timestamptz not null default now(),
  constraint asn_presence_pkey primary key (node, window_name),
  constraint asn_presence_node_fkey foreign key (node) references relay.nodes(id),
  constraint asn_presence_status_check check (status in ('online', 'away', 'busy')),
  constraint asn_presence_name_check check (char_length(window_name) between 1 and 40),
  constraint asn_presence_version_check check (version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,16})?$'),
  constraint asn_presence_psm_check check (psm is null or char_length(psm) <= 80)
);
create index asn_presence_updated_idx on relay.asn_presence (updated_at);
alter table relay.asn_presence enable row level security;
revoke all on relay.asn_presence from public, anon, authenticated;

-- 回報：status 為 offline 就刪掉那一列；其餘寫入或更新。每個節點最多 20 列（防止亂灌視窗名）。
create or replace function public.irori_relay_asn_presence_set(p_node text, p_window text, p_version text, p_status text, p_psm text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_window text := btrim(p_window);
  v_psm text := nullif(btrim(coalesce(p_psm, '')), '');
begin
  if v_window is null or char_length(v_window) not between 1 and 40 or v_window ~ '[[:cntrl:]]' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active') then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_status = 'offline' then
    delete from relay.asn_presence where node = p_node and window_name = v_window;
    return jsonb_build_object('ok', true);
  end if;
  if p_status is null or p_status not in ('online', 'away', 'busy')
     or p_version is null or p_version !~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,16})?$'
     or (v_psm is not null and (char_length(v_psm) > 80 or v_psm ~ '[[:cntrl:]]')) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and window_name = v_window)
     and (select count(*) from relay.asn_presence where node = p_node) >= 20 then
    return jsonb_build_object('error', 'too_many');
  end if;
  insert into relay.asn_presence (node, window_name, version, status, psm, updated_at)
    values (p_node, v_window, p_version, p_status, v_psm, now())
  on conflict (node, window_name) do update
    set version = excluded.version, status = excluded.status, psm = excluded.psm, updated_at = excluded.updated_at;
  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.irori_relay_asn_presence_set(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.irori_relay_asn_presence_set(text, text, text, text, text) to service_role;

-- 名單：每個節點多帶 asn（3 分鐘內有回報的 ASN 視窗）；其餘欄位與原本完全相同
create or replace function public.irori_relay_list(p_tenant uuid)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id, 'name', n.name, 'kind', n.kind, 'machine', n.machine,
    'online', coalesce(n.last_seen_at > now() - interval '3 minutes', false),
    'presence', case when n.last_seen_at > now() - interval '3 minutes' then 'live'
                     when n.last_seen_at > now() - interval '24 hours' then 'recent' else 'idle' end,
    'last_seen_at', n.last_seen_at,
    'avatar_updated_at', case when n.avatar is null then null else n.avatar_updated_at end,
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', r.status, 'cwd_label', r.cwd_label, 'engine', r.engine) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at > now() - interval '3 minutes'
    ), '[]'::jsonb),
    'asn', coalesce((
      select jsonb_agg(jsonb_build_object('window_name', p.window_name, 'version', p.version, 'status', p.status, 'psm', p.psm, 'updated_at', p.updated_at) order by p.window_name)
      from relay.asn_presence p where p.node = n.id and p.updated_at > now() - interval '3 minutes'
    ), '[]'::jsonb)) order by n.id), '[]'::jsonb)
  from relay.nodes n where n.status = 'active' and n.tenant_id is not distinct from p_tenant;
$function$;

revoke all on function public.irori_relay_list(uuid) from public, anon, authenticated;
grant execute on function public.irori_relay_list(uuid) to service_role;

-- 90 天清理（比照 relay-purge-90d）：每天 03:23（UTC）刪掉 90 天沒回報的列
create extension if not exists pg_cron;
select cron.unschedule('asn-presence-purge-90d') where exists (select 1 from cron.job where jobname = 'asn-presence-purge-90d');
select cron.schedule('asn-presence-purge-90d', '23 3 * * *', $$
  delete from relay.asn_presence where updated_at < now() - interval '90 days';
$$);

commit;
