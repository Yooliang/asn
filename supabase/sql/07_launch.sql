-- 07_launch.sql：遠端開 Claude 視窗（#64，規劃見 docs/relay/LAUNCHER.md）。
-- 用途：小良哥在 Irori Chat「聯絡人」分頁對某台電腦按「＋ 開新視窗」→ 這裡記一筆 launch（pending）→ 敲該機器節點的門鈴
--   → 機器橋 launch_pending 取走（taken）→ 照本機 launcher.json 開視窗 → launch_result 回報（ok／failed／unconfirmed）。
-- 安全：
--   - 只有 role=owner 的節點能下令（小良哥經 irori-api，身分是希緒的 owner 節點）；其他節點一律 forbidden。
--   - 訊息不帶任何指令：只有 profile 名、視窗名、cwd（必須在該機器回報的 cwd_allow 裡）；真正執行什麼由該機器的 launcher.json 決定。
--   - 視窗名格式、與現有視窗／進行中的 launch 不重名、每台每小時上限（機器回報的 max_per_hour，最多 20），每次都留紀錄。
--   - 機器橋執行前會再驗一次（profile、名稱、cwd、次數），這裡只是第一道。
-- 執行方式：npx supabase db query --linked -f supabase/sql/07_launch.sql（可重複執行）

-- 機器回報的啟動設定摘要（只有 profile 名與標籤、cwd 白名單、每小時上限；不含指令內容）
alter table relay.nodes add column if not exists launcher jsonb;
alter table relay.nodes add column if not exists launcher_at timestamptz;

create table if not exists relay.launches (
  id uuid primary key default gen_random_uuid(),
  requested_by text not null references relay.nodes(id),
  node text not null references relay.nodes(id),
  profile text not null,
  name text not null,
  cwd text not null,
  first_message text check (first_message is null or char_length(first_message) between 1 and 4000),
  status text not null default 'pending' check (status in ('pending', 'taken', 'ok', 'failed', 'unconfirmed')),
  detail text,
  created_at timestamptz not null default now(),
  taken_at timestamptz,
  done_at timestamptz
);
create index if not exists launches_node_idx on relay.launches (node, created_at);
alter table relay.launches enable row level security;
revoke all on relay.launches from public, anon, authenticated;

-- 名稱規則（與 irori-api、機器橋相同）：英數、連字號、中文，1～40 字，不能以連字號開頭（避免被當成命令列旗標）
create or replace function public.irori_relay_launch_name_ok(p_name text)
returns boolean
language sql immutable set search_path = ''
as $$
  select p_name is not null and p_name ~ '^[A-Za-z0-9一-鿿][A-Za-z0-9一-鿿-]{0,39}$';
$$;

-- 機器回報啟動設定（跟 roster 同一個權限：can_invite 或 can_roster）。p_launcher 為 null＝這台沒有 launcher.json（清掉）
create or replace function public.irori_relay_set_launcher(p_node text, p_launcher jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active' and (can_invite or can_roster)) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_launcher is not null and (
       jsonb_typeof(p_launcher) <> 'object'
    or jsonb_typeof(p_launcher->'profiles') is distinct from 'array'
    or jsonb_typeof(p_launcher->'cwd_allow') is distinct from 'array'
    or jsonb_array_length(p_launcher->'profiles') > 20
    or jsonb_array_length(p_launcher->'cwd_allow') > 50
    or octet_length(p_launcher::text) > 16000
    or exists (select 1 from jsonb_array_elements(p_launcher->'profiles') p
               where jsonb_typeof(p->'id') is distinct from 'string' or char_length(p->>'id') not between 1 and 40
                  or char_length(coalesce(p->>'label', '')) > 60)
    or exists (select 1 from jsonb_array_elements(p_launcher->'cwd_allow') c
               where jsonb_typeof(c) <> 'string' or char_length(c #>> '{}') not between 1 and 260)
  ) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.nodes set launcher = case when p_launcher is null then null else jsonb_build_object(
      'profiles', p_launcher->'profiles', 'cwd_allow', p_launcher->'cwd_allow',
      'max_per_hour', least(greatest(coalesce((p_launcher->>'max_per_hour')::int, 6), 1), 20)) end,
    launcher_at = now()
  where id = p_node;
  return jsonb_build_object('ok', true);
end;
$$;

-- 下令開視窗（只有 owner 節點）
create or replace function public.irori_relay_launch(
  p_actor text, p_node text, p_profile text, p_name text, p_cwd text, p_first text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_l jsonb;
  v_topic text;
  v_max int;
  v_id uuid;
begin
  if not exists (select 1 from relay.nodes where id = p_actor and role = 'owner' and status = 'active') then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select launcher, bell_topic into v_l, v_topic from relay.nodes where id = p_node and status = 'active';
  if v_topic is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_l is null then
    return jsonb_build_object('error', 'no_launcher');
  end if;
  if not public.irori_relay_launch_name_ok(p_name) then
    return jsonb_build_object('error', 'bad_name');
  end if;
  if p_profile is null or not exists (select 1 from jsonb_array_elements(v_l->'profiles') p where p->>'id' = p_profile) then
    return jsonb_build_object('error', 'bad_profile');
  end if;
  if p_cwd is null or not exists (select 1 from jsonb_array_elements_text(v_l->'cwd_allow') c where c = p_cwd) then
    return jsonb_build_object('error', 'bad_cwd');
  end if;
  if p_first is not null and char_length(p_first) > 4000 then
    return jsonb_build_object('error', 'bad_first_message');
  end if;
  -- 跟這台現有的視窗（3 分鐘內回報過）或還在進行中的 launch 重名
  if exists (select 1 from relay.roster where node = p_node and lower(name) = lower(p_name) and seen_at > now() - interval '3 minutes')
     or exists (select 1 from relay.launches where node = p_node and lower(name) = lower(p_name)
                and (status in ('pending', 'taken') and created_at > now() - interval '10 minutes'
                     or status in ('ok', 'unconfirmed') and done_at > now() - interval '3 minutes')) then
    return jsonb_build_object('error', 'name_taken');
  end if;
  v_max := coalesce((v_l->>'max_per_hour')::int, 6);
  if (select count(*) from relay.launches where node = p_node and created_at > now() - interval '1 hour') >= v_max then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.launches (requested_by, node, profile, name, cwd, first_message)
    values (p_actor, p_node, p_profile, p_name, p_cwd, nullif(p_first, ''))
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$$;

-- 機器取走自己的待辦（2 分鐘內的 pending；超過的標 failed＝逾時，避免電腦開機後突然補開一堆視窗）
create or replace function public.irori_relay_launch_pending(p_node text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_out jsonb;
begin
  update relay.launches set status = 'failed', detail = '機器橋 2 分鐘內沒有取走（電腦可能沒開或橋沒在跑）', done_at = now()
    where node = p_node and status = 'pending' and created_at <= now() - interval '2 minutes';
  with t as (
    update relay.launches set status = 'taken', taken_at = now()
      where node = p_node and status = 'pending'
      returning id, requested_by, profile, name, cwd, first_message, created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'requested_by', t.requested_by, 'profile', t.profile, 'name', t.name, 'cwd', t.cwd,
      'first_message', t.first_message, 'created_at', t.created_at) order by t.created_at), '[]'::jsonb)
    into v_out from t;
  return v_out;
end;
$$;

-- 機器回報結果（只能改自己節點、已取走的那筆）
create or replace function public.irori_relay_launch_result(p_node text, p_id uuid, p_status text, p_detail text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_n int;
begin
  if p_status not in ('ok', 'failed', 'unconfirmed') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.launches set status = p_status, detail = left(p_detail, 500), done_at = now()
    where id = p_id and node = p_node and status in ('taken', 'unconfirmed');
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- 給 owner 看：各機器的啟動設定與最近的啟動紀錄（含逾時判定）。p_ids 給了就只回那幾筆紀錄（查進度用）
create or replace function public.irori_relay_launchers(p_actor text, p_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_mach jsonb; v_recent jsonb;
begin
  if not exists (select 1 from relay.nodes where id = p_actor and role = 'owner' and status = 'active') then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'node', n.id, 'name', n.name, 'machine', n.machine, 'launcher', n.launcher, 'launcher_at', n.launcher_at,
      'online', coalesce(n.last_seen_at > now() - interval '3 minutes', false)) order by n.id), '[]'::jsonb)
    into v_mach from relay.nodes n where n.status = 'active' and n.launcher is not null;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'node', l.node, 'profile', l.profile, 'name', l.name, 'cwd', l.cwd,
      'status', case when l.status = 'pending' and l.created_at <= now() - interval '2 minutes' then 'failed' else l.status end,
      'detail', case when l.status = 'pending' and l.created_at <= now() - interval '2 minutes'
                     then '機器橋 2 分鐘內沒有取走（電腦可能沒開或橋沒在跑）' else l.detail end,
      'created_at', l.created_at, 'done_at', l.done_at) order by l.created_at desc), '[]'::jsonb)
    into v_recent from (
      select * from relay.launches
      where (p_ids is null and created_at > now() - interval '7 days') or id = any(p_ids)
      order by created_at desc limit 30
    ) l;
  return jsonb_build_object('machines', v_mach, 'launches', v_recent);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.irori_relay_launch_name_ok(text)',
    'public.irori_relay_set_launcher(text,jsonb)',
    'public.irori_relay_launch(text,text,text,text,text,text)',
    'public.irori_relay_launch_pending(text)',
    'public.irori_relay_launch_result(text,uuid,text,text)',
    'public.irori_relay_launchers(text,uuid[])'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
