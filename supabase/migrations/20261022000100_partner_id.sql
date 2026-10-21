-- 夥伴 ID（issue #109 第一期）：每個 AI 夥伴一個系統產生、永不改變的 ID（p_ 加隨機碼），名字與 session 都可以變。
-- 收發室橋每次回報視窗名單時順便呼叫 irori_relay_partner_sync，後端依規則判斷「是誰」並回傳每個視窗的夥伴 ID：
--   1. 同 session、名字變了 → 同一位夥伴改名（舊名記下，轉寄 7 天內仍解析得到）
--   2. 名字相同、session 換了 → 同一位夥伴換 session（同名就接手），記下 session 交接
--   3. 名字和 session 都換了 → 新夥伴（「這是某某的接班」由第二期在 ASN 指定）
--   4. 同一台同時兩個同名（或同一個 session 出現兩次）→ 不動（維持現有的擋法），回傳裡沒有那個視窗
-- 寄信仍以名字（節點／視窗名）投遞；這一期只是在信上記下收、寄雙方當下的夥伴 ID（trigger 解析），不改變誰收到信。
-- 全部可重複執行（同一份名單報兩次＝沒有任何變化）。先不套用：需要小良哥同意後再套（見 CLAUDE.md）。
begin;

create table relay.partners (
  partner_id text not null,
  tenant_id uuid,
  node text not null,
  current_name text,
  current_session text,
  engine text,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint partners_pkey primary key (partner_id),
  constraint partners_node_fkey foreign key (node) references relay.nodes(id),
  constraint partners_id_check check (partner_id ~ '^p_[0-9a-f]{20}$'),
  constraint partners_name_check check (current_name is null or char_length(current_name) between 1 and 60),
  constraint partners_session_check check (current_session is null or current_session ~ '^[A-Za-z0-9_-]{8,80}$'),
  constraint partners_engine_check check (engine is null or engine ~ '^[a-z][a-z0-9_-]{0,19}$'),
  constraint partners_model_check check (model is null or char_length(model) <= 60)
);
-- 同一台設備上，同一個名字同時只屬於一位夥伴（名字被讓出的夥伴 current_name 為空）
create unique index partners_node_name_uidx on relay.partners (node, current_name) where current_name is not null;
create index partners_node_session_idx on relay.partners (node, current_session);
create index partners_updated_idx on relay.partners (updated_at);
alter table relay.partners enable row level security;
revoke all on relay.partners from public, anon, authenticated;

-- 舊名字（改名當下記一筆）；轉寄期 7 天由解析函式判斷，資料留 90 天
create table relay.partner_names (
  partner_id text not null,
  name text not null,
  renamed_at timestamptz not null default now(),
  constraint partner_names_pkey primary key (partner_id, name, renamed_at),
  constraint partner_names_partner_fkey foreign key (partner_id) references relay.partners(partner_id) on delete cascade,
  constraint partner_names_name_check check (char_length(name) between 1 and 60)
);
create index partner_names_name_idx on relay.partner_names (name, renamed_at desc);
alter table relay.partner_names enable row level security;
revoke all on relay.partner_names from public, anon, authenticated;

-- 歷任 session（ended_at 為空＝目前這一個）；每位夥伴最多留 50 筆
create table relay.partner_sessions (
  partner_id text not null,
  session_id text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  constraint partner_sessions_pkey primary key (partner_id, session_id),
  constraint partner_sessions_partner_fkey foreign key (partner_id) references relay.partners(partner_id) on delete cascade,
  constraint partner_sessions_id_check check (session_id ~ '^[A-Za-z0-9_-]{8,80}$')
);
create index partner_sessions_session_idx on relay.partner_sessions (session_id);
alter table relay.partner_sessions enable row level security;
revoke all on relay.partner_sessions from public, anon, authenticated;

-- 信上記收、寄雙方當下的夥伴 ID（可空：舊寄件端、找不到、尚未同步都是空）
alter table relay.messages add column if not exists to_partner_id text;
alter table relay.messages add column if not exists from_partner_id text;

-- 同步：節點取自金鑰（呼叫端傳 me.id），只動自己節點的夥伴。回 {partners:[{name, partner_id}]}
create or replace function public.irori_relay_partner_sync(p_node text, p_windows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_tenant uuid;
  v_dup_names text[];
  v_dup_sess text[];
  w record;
  v_pid text;
  v_p relay.partners%rowtype;
  v_out jsonb := '[]'::jsonb;
begin
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active') then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_windows is null or jsonb_typeof(p_windows) <> 'array' or jsonb_array_length(p_windows) > 100 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_windows) a
    where jsonb_typeof(a) <> 'object' or jsonb_typeof(a->'name') is distinct from 'string'
       or char_length(a->>'name') not between 1 and 60 or (a->>'name') ~ '[[:cntrl:]]'
  ) then
    return jsonb_build_object('error', 'bad_request');
  end if;

  -- 同一個節點的同步一次一個（避免兩次回報互相搶著建夥伴）
  perform pg_advisory_xact_lock(hashtext('partner_sync:' || p_node));
  select tenant_id into v_tenant from relay.nodes where id = p_node;

  -- 規則 4：同名（或同 session）出現兩次的視窗不處理
  select coalesce(array_agg(s.n), array[]::text[]) into v_dup_names from (
    select a->>'name' as n from jsonb_array_elements(p_windows) a group by 1 having count(*) > 1) s;
  select coalesce(array_agg(s.n), array[]::text[]) into v_dup_sess from (
    select a->>'session_id' as n from jsonb_array_elements(p_windows) a
    where (a->>'session_id') ~ '^[A-Za-z0-9_-]{8,80}$' group by 1 having count(*) > 1) s;

  for w in
    select a->>'name' as name,
           case when (a->>'session_id') ~ '^[A-Za-z0-9_-]{8,80}$' then a->>'session_id' end as sess,
           case when (a->>'engine') ~ '^[a-z][a-z0-9_-]{0,19}$' then a->>'engine' end as engine,
           left(nullif(btrim(coalesce(a->>'model', '')), ''), 60) as model
    from jsonb_array_elements(p_windows) with ordinality as t(a, ord) order by ord
  loop
    if w.name = any(v_dup_names) or (w.sess is not null and w.sess = any(v_dup_sess)) then
      continue;
    end if;
    v_pid := null;

    -- 規則 1：先看 session（同 session ＝同一位夥伴，名字變了就是改名）
    if w.sess is not null then
      select p.partner_id into v_pid
        from relay.partner_sessions s join relay.partners p on p.partner_id = s.partner_id
        where s.session_id = w.sess and p.node = p_node
        order by p.updated_at desc, p.partner_id limit 1;
    end if;
    if v_pid is not null then
      select * into v_p from relay.partners where partner_id = v_pid for update;
      if v_p.current_name is distinct from w.name then
        -- 這個名字若還掛在另一位夥伴身上（對方已經換 session 離開了），讓出來並記成對方的舊名
        with d as (
          update relay.partners set current_name = null, updated_at = now()
            where node = p_node and current_name = w.name and partner_id <> v_pid
            returning partner_id)
        insert into relay.partner_names (partner_id, name) select partner_id, w.name from d;
        if v_p.current_name is not null then
          insert into relay.partner_names (partner_id, name) values (v_pid, v_p.current_name);
        end if;
        update relay.partners set current_name = w.name, updated_at = now() where partner_id = v_pid;
      end if;
    else
      -- 規則 2：名字相同 → 同一位夥伴；session 換了就記一次交接
      select * into v_p from relay.partners where node = p_node and current_name = w.name for update;
      if found then
        v_pid := v_p.partner_id;
      else
        -- 規則 3：名字和 session 都對不上 → 新夥伴
        v_pid := 'p_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
        insert into relay.partners (partner_id, tenant_id, node, current_name, current_session, engine, model)
          values (v_pid, v_tenant, p_node, w.name, w.sess, w.engine, w.model);
        if w.sess is not null then
          insert into relay.partner_sessions (partner_id, session_id) values (v_pid, w.sess);
        end if;
        v_p := null;
      end if;
    end if;

    -- 已存在的夥伴：session 變了（含舊 session 被接回來）＝交接；沒帶 session（舊橋、未知）就不動
    if v_p.partner_id is not null and w.sess is not null and v_p.current_session is distinct from w.sess then
      update relay.partner_sessions set ended_at = now()
        where partner_id = v_pid and ended_at is null and session_id <> w.sess;
      insert into relay.partner_sessions (partner_id, session_id) values (v_pid, w.sess)
        on conflict (partner_id, session_id) do update set ended_at = null;
      update relay.partners set current_session = w.sess, updated_at = now() where partner_id = v_pid;
      delete from relay.partner_sessions s
        where s.partner_id = v_pid and s.ended_at is not null and s.session_id not in (
          select s2.session_id from relay.partner_sessions s2 where s2.partner_id = v_pid
          order by s2.started_at desc, s2.session_id limit 50);
    end if;

    -- 引擎與模型有帶且不同才更新；其餘只在超過 1 分鐘沒動時碰一下 updated_at（重複回報不產生寫入）
    update relay.partners set engine = coalesce(w.engine, engine), model = coalesce(w.model, model), updated_at = now()
      where partner_id = v_pid
        and (engine is distinct from coalesce(w.engine, engine) or model is distinct from coalesce(w.model, model)
             or updated_at < now() - interval '1 minute');

    v_out := v_out || jsonb_build_array(jsonb_build_object('name', w.name, 'partner_id', v_pid));
  end loop;
  return jsonb_build_object('partners', v_out);
end;
$function$;

revoke all on function public.irori_relay_partner_sync(text, jsonb) from public, anon, authenticated;
grant execute on function public.irori_relay_partner_sync(text, jsonb) to service_role;

-- 名字 → 夥伴 ID：目前的名字優先；其次是 7 天內改掉的舊名（轉寄期）。找不到回空
create or replace function relay.partner_resolve(p_node text, p_name text)
 returns text
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select coalesce(
    (select p.partner_id from relay.partners p where p.node = p_node and p.current_name = p_name),
    (select n.partner_id from relay.partner_names n join relay.partners p on p.partner_id = n.partner_id
       where p.node = p_node and n.name = p_name and n.renamed_at > now() - interval '7 days'
       order by n.renamed_at desc, n.partner_id limit 1));
$function$;
revoke all on function relay.partner_resolve(text, text) from public, anon, authenticated;
grant execute on function relay.partner_resolve(text, text) to service_role;

-- 寄信當下解析並記在信上（trigger：寄信函式一行不動；解析失敗不擋寄信）
create or replace function relay.messages_resolve_partner()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  begin
    if new.to_partner_id is null and new.to_agent is not null then
      new.to_partner_id := relay.partner_resolve(new.to_node, new.to_agent);
    end if;
    if new.from_partner_id is null and new.from_agent is not null then
      new.from_partner_id := relay.partner_resolve(new.from_node, new.from_agent);
    end if;
  exception when others then
    null;
  end;
  return new;
end;
$function$;
revoke all on function relay.messages_resolve_partner() from public, anon, authenticated;

drop trigger if exists messages_resolve_partner on relay.messages;
create trigger messages_resolve_partner before insert on relay.messages
  for each row execute function relay.messages_resolve_partner();

-- 清理：舊名紀錄留 90 天；180 天沒回報的夥伴整筆刪（名字與 session 歷史跟著刪）。每天 03:31（UTC）
create extension if not exists pg_cron;
select cron.unschedule('asn-partners-purge') where exists (select 1 from cron.job where jobname = 'asn-partners-purge');
select cron.schedule('asn-partners-purge', '31 3 * * *', $$
  delete from relay.partner_names where renamed_at < now() - interval '90 days';
  delete from relay.partners where updated_at < now() - interval '180 days';
$$);

commit;
