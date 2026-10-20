-- 退回 30：名單函式換回 19_roster_engine.sql 的版本（沒有 avatar_updated_at），拿掉兩個函式與兩個欄位（大頭貼資料會一併刪除）。
-- 要先把 irori-relay 退回沒有 avatar／set_avatar 動作的版本，否則這兩個動作會呼叫到不存在的函式（只會回 500，不影響其他動作）。
begin;

create or replace function public.irori_relay_list(p_tenant uuid)
returns jsonb
language sql security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id, 'name', n.name, 'kind', n.kind, 'machine', n.machine,
    'online', coalesce(n.last_seen_at > now() - interval '3 minutes', false),
    'presence', case when n.last_seen_at > now() - interval '3 minutes' then 'live'
                     when n.last_seen_at > now() - interval '24 hours' then 'recent' else 'idle' end,
    'last_seen_at', n.last_seen_at,
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', r.status, 'cwd_label', r.cwd_label, 'engine', r.engine) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at > now() - interval '3 minutes'
    ), '[]'::jsonb)) order by n.id), '[]'::jsonb)
  from relay.nodes n where n.status = 'active' and n.tenant_id is not distinct from p_tenant;
$$;
revoke execute on function public.irori_relay_list(uuid) from public, anon, authenticated;
grant execute on function public.irori_relay_list(uuid) to service_role;

drop function if exists public.irori_relay_set_avatar(text, text);
drop function if exists public.irori_relay_get_avatar(uuid, text);
alter table relay.nodes drop constraint if exists nodes_avatar_check;
alter table relay.nodes drop column if exists avatar;
alter table relay.nodes drop column if exists avatar_updated_at;

commit;
