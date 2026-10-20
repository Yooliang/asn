-- 30_node_avatar.sql：每台設備（節點）可以上傳一張大頭貼（ASN 電腦版用）。
-- 做法：
--   relay.nodes 加 avatar（data URL，只收 png／webp、全長 ≤ 48000 字、base64 字元）與 avatar_updated_at；
--   irori_relay_list(uuid) 每個節點多回傳 avatar_updated_at（名單不帶圖本身，流量不會跟著節點數與名單輪詢放大：
--     ASN 每 60 秒拉一次名單，圖只在更新時間變了才用 avatar 動作單獨取一次）；
--   irori_relay_set_avatar(p_node, p_avatar)：只能改 p_node 自己（呼叫端用節點金鑰決定是誰）；null＝移除；
--   irori_relay_get_avatar(p_tenant, p_node)：取某節點的圖，限同一租戶的現役節點。
-- 執行方式：npx supabase db query --linked -f supabase/sql/30_node_avatar.sql（可重複執行；supabase/sql 沒有自動套用，一律手動）
-- 部署順序：先跑這支 SQL，再部署 irori-relay 函式（SQL 先上線時舊函式照常運作，只是名單多了 avatar_updated_at 欄位、沒人讀）。
-- 回復：supabase/sql/rollback/30_node_avatar_down.sql
-- 權限：revoke 掉 public／anon／authenticated，只授權 service_role（和 01～29 一致）；relay schema 不暴露給 PostgREST。
begin;

alter table relay.nodes add column if not exists avatar text;
alter table relay.nodes add column if not exists avatar_updated_at timestamptz;

-- 格式與大小的最後一道防線（後端函式與 ASN 也各擋一次）
alter table relay.nodes drop constraint if exists nodes_avatar_check;
alter table relay.nodes add constraint nodes_avatar_check check (
  avatar is null or (
    char_length(avatar) <= 48000
    and avatar ~ '^data:image/(png|webp);base64,[A-Za-z0-9+/]+={0,2}$'
  )
);

-- 名單：與 19_roster_engine.sql 的版本相同，只多一個 avatar_updated_at（沒上傳＝null）
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
    'avatar_updated_at', case when n.avatar is null then null else n.avatar_updated_at end,
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'status', r.status, 'cwd_label', r.cwd_label, 'engine', r.engine) order by r.name)
      from relay.roster r where r.node = n.id and r.seen_at > now() - interval '3 minutes'
    ), '[]'::jsonb)) order by n.id), '[]'::jsonb)
  from relay.nodes n where n.status = 'active' and n.tenant_id is not distinct from p_tenant;
$$;

-- 上傳／移除自己這台的大頭貼。p_avatar 為 null＝移除；格式不合回 bad_avatar（資料表的 check 是最後防線）
create or replace function public.irori_relay_set_avatar(p_node text, p_avatar text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_at timestamptz;
begin
  if p_avatar is not null and (
    char_length(p_avatar) > 48000
    or p_avatar !~ '^data:image/(png|webp);base64,[A-Za-z0-9+/]+={0,2}$'
  ) then
    return jsonb_build_object('error', 'bad_avatar');
  end if;
  update relay.nodes set avatar = p_avatar, avatar_updated_at = case when p_avatar is null then null else now() end
    where id = p_node and status = 'active'
    returning avatar_updated_at into v_at;
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  return jsonb_build_object('ok', true, 'avatar_updated_at', v_at);
end;
$$;

-- 取某節點的大頭貼：只限同一租戶的現役節點；沒上傳回 not_found
create or replace function public.irori_relay_get_avatar(p_tenant uuid, p_node text)
returns jsonb
language sql security definer set search_path = ''
as $$
  select coalesce((
    select jsonb_build_object('node', n.id, 'avatar', n.avatar, 'avatar_updated_at', n.avatar_updated_at)
    from relay.nodes n
    where n.id = p_node and n.status = 'active' and n.avatar is not null and n.tenant_id is not distinct from p_tenant
  ), jsonb_build_object('error', 'not_found'));
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.irori_relay_list(uuid)',
    'public.irori_relay_set_avatar(text,text)',
    'public.irori_relay_get_avatar(uuid,text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;
