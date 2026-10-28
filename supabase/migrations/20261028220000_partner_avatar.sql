-- 0.1.102 #446：夥伴可以自己換頭像（asn avatar set）。照設備頭像（relay.nodes.avatar）的整套再做一份夥伴層。
-- 1. relay.partners 加 avatar（data URL）與 avatar_updated_at，皆可為 null；check 與 relay.nodes 相同：png／webp、全長 ≤ 48000 字、base64 字元
--    （資料庫是最後一道防線；relay 函式與 asn-cli 也各驗一次）。
-- 2. relay.partner_avatar_sets：每次改頭像記一筆，用來限制「每位夥伴每小時 5 次」（只留一天，每次改頭像順手清掉舊的）。
-- 3. asn_relay_set_partner_avatar(p_node, p_agent, p_avatar)：p_node 是 relay 已驗證的節點（不從請求內容取）；夥伴用 node＋current_name 精確比對；
--    p_avatar 為 null＝移除。回 ok／bad_request／bad_avatar／not_found／rate_limited。
-- 4. asn_relay_get_partner_avatar(p_tenant, p_partner)：取某位夥伴的圖，限同一租戶的現役節點；沒有圖回 not_found。
-- 5. asn_relay_list 的在線夥伴與離線夥伴各多一個 avatar_updated_at（沒有圖＝null）；其餘照正式庫現行定義一個字不動
--    （2026-10-28 #473 部署後唯讀取自正式庫，基準檔 tests/fixtures/asn_relay_list.prod-20261028b.sql，測試比對「只多這兩行」）。
-- 信任邊界：後台只認節點金鑰，同一台電腦上的視窗在伺服器看起來是同一個人（和寄信的 from_agent 一樣）；不同電腦、不同帳號改不到。
-- 只加欄位、表與函式；舊版用戶端不認得新欄位就略過。部署順序：migration → relay 函式 → 用戶端。
begin;

alter table relay.partners add column if not exists avatar text;
alter table relay.partners add column if not exists avatar_updated_at timestamptz;
alter table relay.partners drop constraint if exists partners_avatar_check;
alter table relay.partners add constraint partners_avatar_check check (
  avatar is null or (
    char_length(avatar) <= 48000
    and avatar ~ '^data:image/(png|webp);base64,[A-Za-z0-9+/]+={0,2}$'
  )
);

create table if not exists relay.partner_avatar_sets (
  partner_id text not null,
  at timestamptz not null default now(),
  constraint partner_avatar_sets_partner_fkey foreign key (partner_id) references relay.partners(partner_id) on delete cascade
);
create index if not exists partner_avatar_sets_idx on relay.partner_avatar_sets (partner_id, at desc);
alter table relay.partner_avatar_sets enable row level security;
revoke all on relay.partner_avatar_sets from public, anon, authenticated;

create or replace function public.asn_relay_set_partner_avatar(p_node text, p_agent text, p_avatar text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_pid text;
  v_n int;
  v_at timestamptz;
begin
  if p_node is null or p_node = '' or p_agent is null or p_agent = '' or char_length(p_agent) > 100 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if p_avatar is not null and (
    char_length(p_avatar) > 48000
    or p_avatar !~ '^data:image/(png|webp);base64,[A-Za-z0-9+/]+={0,2}$'
  ) then
    return jsonb_build_object('error', 'bad_avatar');
  end if;
  select p.partner_id into v_pid
    from relay.partners p join relay.nodes n on n.id = p.node
    where p.node = p_node and p.current_name = p_agent and n.status = 'active'
    for update of p;
  if v_pid is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  delete from relay.partner_avatar_sets where partner_id = v_pid and at < now() - interval '1 day';
  select count(*) into v_n from relay.partner_avatar_sets where partner_id = v_pid and at > now() - interval '1 hour';
  if v_n >= 5 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.partner_avatar_sets (partner_id) values (v_pid);
  update relay.partners set avatar = p_avatar, avatar_updated_at = case when p_avatar is null then null else now() end
    where partner_id = v_pid
    returning avatar_updated_at into v_at;
  return jsonb_build_object('ok', true, 'partner_id', v_pid, 'avatar_updated_at', v_at);
end;
$function$;

create or replace function public.asn_relay_get_partner_avatar(p_tenant uuid, p_partner text)
returns jsonb
language sql
security definer
set search_path to ''
as $function$
  select coalesce((
    select jsonb_build_object('partner_id', p.partner_id, 'avatar', p.avatar, 'avatar_updated_at', p.avatar_updated_at)
    from relay.partners p join relay.nodes n on n.id = p.node
    where p.partner_id = p_partner and p.avatar is not null and n.status = 'active' and n.tenant_id is not distinct from p_tenant
  ), jsonb_build_object('error', 'not_found'));
$function$;

create or replace function public.asn_relay_list(p_tenant uuid)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id, 'name', n.name, 'kind', n.kind, 'machine', n.machine,
    'online', coalesce(n.last_seen_at > now() - interval '3 minutes', false),
    'presence', case when n.last_seen_at > now() - interval '3 minutes' then 'live'
                     when n.last_seen_at > now() - interval '24 hours' then 'recent' else 'idle' end,
    'last_seen_at', n.last_seen_at,
    'last_active_at', n.last_active_at,
    'claude_mod', case when n.claude_mod is null then null else n.claude_mod || jsonb_build_object('updated_at', n.claude_mod_at) end,
    'avatar_updated_at', case when n.avatar is null then null else n.avatar_updated_at end,
    'archived_keys', coalesce((select jsonb_agg(a.key order by a.key) from relay.partner_archives a
                                where a.tenant_id is not distinct from p_tenant and a.node = n.id), '[]'::jsonb),
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', r.status, 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail, 'context_pct', r.context_pct, 'mod_loaded', r.mod_loaded,
        'kind', r.kind, 'receivable', r.receivable, 'model', r.model, 'hidden', r.hidden,
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'online', true,
        'last_active_at', (select p.last_active_at from relay.partners p where p.node = n.id and p.current_name = r.name),
        'avatar_updated_at', (select case when p.avatar is null then null else p.avatar_updated_at end from relay.partners p where p.node = n.id and p.current_name = r.name),
        'archived', exists (select 1 from relay.partner_archives a where a.tenant_id is not distinct from p_tenant
                              and (a.key = 'n:' || n.id || '/' || r.name
                                   or a.key = (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name)))) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at > now() - interval '3 minutes'
    ), '[]'::jsonb),
    'offline_agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', 'offline', 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail, 'context_pct', r.context_pct, 'mod_loaded', r.mod_loaded,
        'kind', r.kind, 'receivable', r.receivable, 'model', r.model, 'hidden', r.hidden,
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'online', false,
        'last_active_at', (select p.last_active_at from relay.partners p where p.node = n.id and p.current_name = r.name),
        'avatar_updated_at', (select case when p.avatar is null then null else p.avatar_updated_at end from relay.partners p where p.node = n.id and p.current_name = r.name),
        'last_seen_at', r.seen_at,
        'archived', exists (select 1 from relay.partner_archives a where a.tenant_id is not distinct from p_tenant
                              and (a.key = 'n:' || n.id || '/' || r.name
                                   or a.key = (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name)))) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at <= now() - interval '3 minutes' and r.seen_at > now() - interval '30 days'
    ), '[]'::jsonb),
    'asn', coalesce((
      select jsonb_agg(jsonb_build_object('window_name', p.window_name, 'version', p.version, 'status', p.status, 'psm', p.psm, 'updated_at', p.updated_at) order by p.window_name)
      from relay.asn_presence p where p.node = n.id and p.updated_at > now() - interval '3 minutes'
    ), '[]'::jsonb)) order by n.id), '[]'::jsonb)
  from relay.nodes n where n.status = 'active' and n.tenant_id is not distinct from p_tenant;
$function$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.asn_relay_set_partner_avatar(text,text,text)',
    'public.asn_relay_get_partner_avatar(uuid,text)',
    'public.asn_relay_list(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;
