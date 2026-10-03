-- 19_roster_engine.sql：名單的視窗多一個「引擎」欄位（claude／codex／gemini／grok…）。
-- 用途：機器橋的 acp 轉接器讓 Gemini 以「背景工作者」形式上線，手機聯絡人要能依引擎顯示頭像與種類；
--   舊版機器橋沒帶 engine → 欄位是 null → 前端當成 Claude（行為不變）。
-- 做法：relay.roster 加 engine 欄位；irori_relay_roster（04_roster.sql 的版本）多收 engine；irori_relay_list(uuid)（16_tenants.sql 的版本）多回傳 engine。
-- 執行方式：npx supabase db query --linked -f supabase/sql/19_roster_engine.sql（可重複執行；只加欄位、換函式本體，不動資料）
-- 部署順序：先跑這支 SQL，再部署 irori-relay／irori-api 兩個函式（SQL 先上線時舊函式照常運作，只是沒有 engine）。
-- 回復：重跑 04_roster.sql 與 16_tenants.sql 裡的同名函式；欄位留著無妨。
-- 權限：create or replace function 會保留原函式既有的 grant／revoke（只有 service_role 能執行）。

alter table relay.roster add column if not exists engine text;

create or replace function public.irori_relay_roster(p_node text, p_agents jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_n int;
begin
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active' and (can_invite or can_roster)) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_agents is null or jsonb_typeof(p_agents) <> 'array' or jsonb_array_length(p_agents) > 100 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_agents) a
    where jsonb_typeof(a) <> 'object' or jsonb_typeof(a->'name') is distinct from 'string'
       or char_length(a->>'name') not between 1 and 60
       or char_length(coalesce(a->>'status', '')) > 20 or char_length(coalesce(a->>'cwd_label', '')) > 80
  ) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  delete from relay.roster where node = p_node;
  -- same name twice in one report: the last one wins；engine 格式不對就當沒帶（不因此整份名單被拒）
  insert into relay.roster (node, name, status, cwd_label, engine)
    select distinct on (a.v->>'name') p_node, a.v->>'name', nullif(a.v->>'status', ''), nullif(a.v->>'cwd_label', ''),
           case when a.v->>'engine' ~ '^[a-z][a-z0-9_-]{0,19}$' then a.v->>'engine' end
    from jsonb_array_elements(p_agents) with ordinality as a(v, ord)
    order by a.v->>'name', a.ord desc;
  get diagnostics v_n = row_count;
  return jsonb_build_object('count', v_n);
end;
$$;

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
