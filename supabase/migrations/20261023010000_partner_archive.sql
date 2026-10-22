-- 封存夥伴：讓某位 AI 夥伴從名單上消失（記在帳號層，同租戶所有設備同步）。
-- 鍵：有夥伴 ID 用夥伴 ID；沒有就用「n:節點/名字」。後台不濾掉，名單（irori_relay_list）的每位成員多帶 archived 旗標，由前端決定怎麼顯示
--   （舊用戶端多一個鍵會略過）。往來記錄、未讀、通知都不動。
-- 自動解除：① 封存時它是離線、之後視窗重新回報（irori_relay_partner_sync 有它）② 它寄信來（relay.messages 寫入後）。
--   寄信本身的行為與回傳完全不變（寫入後的觸發器，出錯一律吞掉）。
-- 下令一律要本人簽章（p_signed_user，Edge Function 驗過登入憑證才傳進來），且簽章的人要擁有「呼叫節點」與「目標節點」，比照 partner_op。
-- 先不套用：部署順序為 migration → relay 函式 → 發新版 ASN（反過來也安全：舊後台對 partner_archive 回 404，介面會說「請先更新」）。
begin;

create table if not exists relay.partner_archives (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  key text not null check (char_length(key) between 3 and 140),
  node text not null references relay.nodes(id),
  name text not null check (char_length(name) between 1 and 80),
  was_offline boolean not null default false,   -- 封存當下它是離線：之後重新上線才自動解除（封存時它在線上，就只有寄信會解除）
  archived_by text references relay.nodes(id),
  archived_at timestamptz not null default now()
);
create unique index if not exists partner_archives_key_idx on relay.partner_archives (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key);
create index if not exists partner_archives_key_only_idx on relay.partner_archives (key);
alter table relay.partner_archives enable row level security;
revoke all on relay.partner_archives from public, anon, authenticated;

-- 封存／取消封存（手機與電腦版共用，要本人簽章）。回 { ok: true, archived }
create or replace function public.irori_relay_partner_archive(
  p_actor text, p_signed_user uuid, p_node text, p_name text, p_partner_id text, p_archived boolean
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_t uuid;
  v_key text;
  v_name text := p_name;
  v_offline boolean;
begin
  if p_archived is null or p_node is null
     or (p_partner_id is not null and p_partner_id !~ '^p_[0-9a-f]{20}$')
     or (p_partner_id is null and (p_name is null or char_length(p_name) not between 1 and 80)) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select tenant_id into v_t from relay.nodes
    where id = p_actor and status = 'active' and public.asn_user_owns_node(p_signed_user, p_actor);
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active' and tenant_id is not distinct from v_t
                   and public.asn_user_owns_node(p_signed_user, p_node)) then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_partner_id is not null then
    -- 夥伴 ID：必須是這個租戶、這個節點上的夥伴；名字以夥伴現在的為準（沒有現名就用最近的舊名）
    select coalesce(p.current_name, (select n.name from relay.partner_names n where n.partner_id = p.partner_id order by n.renamed_at desc limit 1))
      into v_name from relay.partners p
      where p.partner_id = p_partner_id and p.node = p_node and p.tenant_id is not distinct from v_t;
    if not found or v_name is null then
      return jsonb_build_object('error', 'not_found');
    end if;
    v_key := p_partner_id;
  else
    -- 沒帶夥伴 ID：名字若對得上這台的夥伴就用它的 ID（名單是用夥伴 ID 比對的），都對不上才用「節點＋名字」
    select p.partner_id into v_key from relay.partners p
      where p.node = p_node and p.current_name = p_name and p.tenant_id is not distinct from v_t limit 1;
    if v_key is null then
      v_key := 'n:' || p_node || '/' || p_name;
    end if;
  end if;
  if v_name ~ '收發室$' or exists (select 1 from relay.roster where node = p_node and name = v_name and engine = 'asn') then
    return jsonb_build_object('error', 'protected');
  end if;
  if not p_archived then
    delete from relay.partner_archives where tenant_id is not distinct from v_t and key = v_key;
    return jsonb_build_object('ok', true, 'archived', false);
  end if;
  if p_partner_id is null and not exists (select 1 from relay.roster where node = p_node and name = p_name) then
    return jsonb_build_object('error', 'not_found');
  end if;
  if (select count(*) from relay.partner_archives where tenant_id is not distinct from v_t) >= 500
     and not exists (select 1 from relay.partner_archives where tenant_id is not distinct from v_t and key = v_key) then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  v_offline := not exists (select 1 from relay.roster where node = p_node and name = v_name and seen_at > now() - interval '3 minutes');
  insert into relay.partner_archives (tenant_id, key, node, name, was_offline, archived_by)
    values (v_t, v_key, p_node, v_name, v_offline, p_actor)
    on conflict (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
    do update set was_offline = excluded.was_offline, archived_by = excluded.archived_by, archived_at = now(), name = excluded.name;
  return jsonb_build_object('ok', true, 'archived', true);
end;
$function$;
revoke all on function public.irori_relay_partner_archive(text, uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.irori_relay_partner_archive(text, uuid, text, text, text, boolean) to service_role;

-- 名單：每位成員多帶 archived（其餘與 20261022110000 完全相同）
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
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', r.status, 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail,
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'online', true,
        'archived', exists (select 1 from relay.partner_archives a where a.tenant_id is not distinct from p_tenant
                              and a.key = coalesce((select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'n:' || n.id || '/' || r.name))) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at > now() - interval '3 minutes'
    ), '[]'::jsonb),
    'offline_agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', 'offline', 'cwd_label', r.cwd_label, 'engine', r.engine, 'detail', r.detail,
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'online', false,
        'last_seen_at', r.seen_at,
        'archived', exists (select 1 from relay.partner_archives a where a.tenant_id is not distinct from p_tenant
                              and a.key = coalesce((select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'n:' || n.id || '/' || r.name))) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at <= now() - interval '3 minutes' and r.seen_at > now() - interval '30 days'
    ), '[]'::jsonb),
    'asn', coalesce((
      select jsonb_agg(jsonb_build_object('window_name', p.window_name, 'version', p.version, 'status', p.status, 'psm', p.psm, 'updated_at', p.updated_at) order by p.window_name)
      from relay.asn_presence p where p.node = n.id and p.updated_at > now() - interval '3 minutes'
    ), '[]'::jsonb)) order by n.id), '[]'::jsonb)
  from relay.nodes n where n.status = 'active' and n.tenant_id is not distinct from p_tenant;
$function$;
revoke all on function public.irori_relay_list(uuid) from public, anon, authenticated;
grant execute on function public.irori_relay_list(uuid) to service_role;

-- 自動解除 ①：視窗重新回報。不重貼那一大段規則：把原本的同步函式改名成 _core，用薄薄的新函式包起來（回傳完全相同），成功後再解除。
do $$
begin
  -- 可安全重跑：已經改過名（_core 存在）就不再改，否則第二次會把外面這層當成原本的同步函式
  if not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = 'irori_relay_partner_sync_core') then
    alter function public.irori_relay_partner_sync(text, jsonb) rename to irori_relay_partner_sync_core;
  end if;
end
$$;
revoke all on function public.irori_relay_partner_sync_core(text, jsonb) from public, anon, authenticated;

create or replace function public.irori_relay_partner_sync(p_node text, p_windows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_out jsonb;
begin
  v_out := public.irori_relay_partner_sync_core(p_node, p_windows);
  begin
    if v_out ? 'partners' and exists (select 1 from relay.partner_archives where node = p_node and was_offline) then
      -- 封存時是離線、現在又回報了這個視窗（夥伴 ID 或同名）：解除
      delete from relay.partner_archives a
        where a.node = p_node and a.was_offline
          and exists (select 1 from jsonb_array_elements(v_out->'partners') x
                      where x->>'partner_id' = a.key or 'n:' || p_node || '/' || (x->>'name') = a.key);
    end if;
  exception when others then
    null;
  end;
  return v_out;
end;
$function$;
revoke all on function public.irori_relay_partner_sync(text, jsonb) from public, anon, authenticated;
grant execute on function public.irori_relay_partner_sync(text, jsonb) to service_role;

-- 自動解除 ②：它寄信來（寫入後；不影響寄信本身，出錯一律吞掉）
create or replace function relay.messages_unarchive_sender()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  begin
    if new.from_agent is not null then
      delete from relay.partner_archives
        where key = 'n:' || new.from_node || '/' || new.from_agent
           or (new.from_partner_id is not null and key = new.from_partner_id);
    end if;
  exception when others then
    null;
  end;
  return null;
end;
$function$;
revoke all on function relay.messages_unarchive_sender() from public, anon, authenticated;
drop trigger if exists messages_unarchive_sender on relay.messages;
create trigger messages_unarchive_sender after insert on relay.messages
  for each row execute function relay.messages_unarchive_sender();

commit;
