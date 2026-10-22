-- 夥伴 ID 第二期（issue #153）：改名／換 session／換設備都延續同一位夥伴。設計見 docs/design/PARTNER-ID.md「第二期」。
--  1. 寄給舊名字的信改投新名字：信的收件人是該節點某夥伴的舊名（7 天轉寄期內）、而且現在沒有視窗用這個名字
--     （沒有夥伴現用這個名字、名單裡也沒有同名的在線視窗）→ 解析到夥伴 ID，把 to_agent 換成它現在的名字（同節點）。
--     名字現在有人用就照舊不改。原本寫的名字記在 forwarded_from。解析失敗不擋寄信（沿用第一期的 trigger，寄信函式一行不動）。
--  2. 指定接班 irori_relay_partner_succeed：新視窗（節點＋名字，已由 partner_sync 建好夥伴）併入前任夥伴：
--     夥伴 ID 沿用前任，名字／session／引擎／模型／所在節點改成新視窗的；新視窗原本那筆夥伴刪除，信上的夥伴欄位改指前任。
--     要本人簽章：簽章的人必須擁有「呼叫的節點」與「新視窗的節點」，前任必須在同一個租戶；前任的視窗還在線上時拒絕。
--  3. 列出可被接班的夥伴 irori_relay_partner_list（同租戶，本人簽章）。
--  4. asn_chat_history 多一個選填的夥伴 ID：以「帳號＋夥伴 ID」查，改名前後的往來都拿得到（仍併上原本的名字比對，第一期以前的舊信也在）。
--  5. irori_relay_list 的 agents 每列多帶 partner_id（沒有就是 null），ASN 用來查往來記錄與指定接班；舊用戶端多一個鍵會直接略過。
-- 相容：新欄位／新表全部可空或獨立；沒有夥伴 ID 的節點（舊機器橋、雲端代理）完全不受影響；舊 Edge Function 呼叫五個參數的
-- asn_chat_history 仍然有效（第六個參數有預設值）。先不套用：部署由負責的 session 處理。
begin;

-- 信被轉寄時，原本寫的收件名字
alter table relay.messages add column if not exists forwarded_from text;

-- 接班紀錄（稽核用；跟著夥伴一起刪）
create table if not exists relay.partner_handovers (
  id bigint generated always as identity primary key,
  partner_id text not null,
  from_node text,
  from_name text,
  to_node text not null,
  to_name text not null,
  by_user uuid,
  at timestamptz not null default now(),
  constraint partner_handovers_partner_fkey foreign key (partner_id) references relay.partners(partner_id) on delete cascade
);
create index if not exists partner_handovers_partner_idx on relay.partner_handovers (partner_id, at desc);
alter table relay.partner_handovers enable row level security;
revoke all on relay.partner_handovers from public, anon, authenticated;

-- 1. 寄信當下解析並記在信上；收件人是舊名字且沒人用就改投現在的名字
create or replace function relay.messages_resolve_partner()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_cur text;
begin
  begin
    if new.to_partner_id is null and new.to_agent is not null then
      new.to_partner_id := relay.partner_resolve(new.to_node, new.to_agent);
    end if;
    if new.from_partner_id is null and new.from_agent is not null then
      new.from_partner_id := relay.partner_resolve(new.from_node, new.from_agent);
    end if;
    -- 轉寄：有解析到夥伴，但這個名字現在不屬於任何夥伴、名單裡也沒有同名的在線視窗（名字還有人用就照舊）
    if new.to_partner_id is not null and new.to_agent is not null
       and not exists (select 1 from relay.partners p where p.node = new.to_node and p.current_name = new.to_agent)
       and not exists (select 1 from relay.roster r where r.node = new.to_node and r.name = new.to_agent
                       and r.seen_at > now() - interval '3 minutes') then
      select p.current_name into v_cur from relay.partners p
        where p.partner_id = new.to_partner_id and p.node = new.to_node and p.current_name is not null;
      if v_cur is not null and v_cur <> new.to_agent then
        new.forwarded_from := new.to_agent;
        new.to_agent := v_cur;
      end if;
    end if;
  exception when others then
    null;
  end;
  return new;
end;
$function$;
revoke all on function relay.messages_resolve_partner() from public, anon, authenticated;

-- 2. 指定接班
create or replace function public.irori_relay_partner_succeed(p_user uuid, p_caller text, p_predecessor text, p_node text, p_name text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_p relay.partners%rowtype;
  v_n relay.partners%rowtype;
  v_tenant uuid;
  v_a text;
  v_b text;
begin
  if p_user is null or p_predecessor is null or p_predecessor !~ '^p_[0-9a-f]{20}$'
     or p_node is null or p_name is null or char_length(p_name) not between 1 and 60 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 本人簽章：簽章的人要擁有「呼叫的節點」與「新視窗所在的節點」
  if not public.asn_user_owns_node(p_user, p_caller) or not public.asn_user_owns_node(p_user, p_node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select tenant_id into v_tenant from relay.nodes where id = p_node;

  select * into v_p from relay.partners where partner_id = p_predecessor;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_p.tenant_id is distinct from v_tenant then
    return jsonb_build_object('error', 'forbidden');
  end if;

  -- 兩個節點的同步鎖按固定順序拿（避免互等），接班期間不讓名單同步插進來
  v_a := least(p_node, v_p.node);
  v_b := greatest(p_node, v_p.node);
  perform pg_advisory_xact_lock(hashtext('partner_sync:' || v_a));
  if v_b <> v_a then
    perform pg_advisory_xact_lock(hashtext('partner_sync:' || v_b));
  end if;

  select * into v_p from relay.partners where partner_id = p_predecessor for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  select * into v_n from relay.partners where node = p_node and current_name = p_name for update;
  if not found then
    -- 新視窗還沒被 partner_sync 認進來（橋剛啟動）：請稍後再試
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_n.partner_id = v_p.partner_id then
    return jsonb_build_object('ok', true, 'partner_id', v_p.partner_id);   -- 已經是同一位（重複送出）
  end if;
  -- 前任的視窗還開著（3 分鐘內名單有它）→ 不接班，免得兩個視窗搶同一個夥伴 ID
  if v_p.current_name is not null and exists (
       select 1 from relay.roster r where r.node = v_p.node and r.name = v_p.current_name and r.seen_at > now() - interval '3 minutes') then
    return jsonb_build_object('error', 'predecessor_live');
  end if;

  -- session：前任現在開著的收尾，新夥伴的 session 全部併過來（同一個 session 兩邊都有就留前任的）
  update relay.partner_sessions set ended_at = now() where partner_id = v_p.partner_id and ended_at is null;
  delete from relay.partner_sessions s where s.partner_id = v_n.partner_id
    and s.session_id in (select s2.session_id from relay.partner_sessions s2 where s2.partner_id = v_p.partner_id);
  update relay.partner_sessions set partner_id = v_p.partner_id where partner_id = v_n.partner_id;
  delete from relay.partner_sessions s
    where s.partner_id = v_p.partner_id and s.ended_at is not null and s.session_id not in (
      select s2.session_id from relay.partner_sessions s2 where s2.partner_id = v_p.partner_id
      order by s2.started_at desc, s2.session_id limit 50);
  -- 舊名字紀錄、信上的夥伴欄位都改指前任
  insert into relay.partner_names (partner_id, name, renamed_at)
    select v_p.partner_id, n.name, n.renamed_at from relay.partner_names n where n.partner_id = v_n.partner_id
    on conflict do nothing;
  update relay.messages set to_partner_id = v_p.partner_id where to_partner_id = v_n.partner_id;
  update relay.messages set from_partner_id = v_p.partner_id where from_partner_id = v_n.partner_id;
  -- 新視窗原本那筆夥伴刪掉（名字與 session 歷史已搬走），名字讓給前任
  delete from relay.partners where partner_id = v_n.partner_id;

  -- 前任原本的名字記成舊名（同節點才有意義：寄給它的信會轉到新名字）
  if v_p.current_name is not null and v_p.node = p_node and v_p.current_name <> p_name then
    insert into relay.partner_names (partner_id, name) values (v_p.partner_id, v_p.current_name);
  end if;
  update relay.partners
    set node = p_node, tenant_id = v_n.tenant_id, current_name = p_name, current_session = v_n.current_session,
        engine = coalesce(v_n.engine, engine), model = coalesce(v_n.model, model), updated_at = now()
    where partner_id = v_p.partner_id;
  insert into relay.partner_handovers (partner_id, from_node, from_name, to_node, to_name, by_user)
    values (v_p.partner_id, v_p.node, v_p.current_name, p_node, p_name, p_user);
  return jsonb_build_object('ok', true, 'partner_id', v_p.partner_id);
end;
$function$;
revoke all on function public.irori_relay_partner_succeed(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.irori_relay_partner_succeed(uuid, text, text, text, text) to service_role;

-- 3. 可被接班的夥伴（同租戶）：名字取現在的，被讓出的取最近的舊名；最多 100 位，最近有動靜的在前
create or replace function public.irori_relay_partner_list(p_user uuid, p_caller text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_tenant uuid;
  v_out jsonb;
begin
  if not public.asn_user_owns_node(p_user, p_caller) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select tenant_id into v_tenant from relay.nodes where id = p_caller;
  select coalesce(jsonb_agg(x.j order by x.updated_at desc, x.pid), '[]'::jsonb) into v_out from (
    select q.pid, q.updated_at, jsonb_build_object(
        'partner_id', q.pid, 'name', q.name, 'node', q.node, 'device', q.device, 'engine', q.engine,
        'live', q.live, 'updated_at', q.updated_at) as j
    from (
      select p.partner_id as pid, p.updated_at, p.node, p.engine,
             coalesce(p.current_name, (select n.name from relay.partner_names n where n.partner_id = p.partner_id
                                         order by n.renamed_at desc limit 1)) as name,
             (select nd.name from relay.nodes nd where nd.id = p.node) as device,
             (p.current_name is not null and exists (
                select 1 from relay.roster r where r.node = p.node and r.name = p.current_name
                  and r.seen_at > now() - interval '3 minutes')) as live
      from relay.partners p where p.tenant_id = v_tenant
      order by p.updated_at desc, p.partner_id limit 100
    ) q where q.name is not null
  ) x;
  return jsonb_build_object('partners', v_out);
end;
$function$;
revoke all on function public.irori_relay_partner_list(uuid, text) from public, anon, authenticated;
grant execute on function public.irori_relay_partner_list(uuid, text) to service_role;

-- 4. 往來記錄：多一個選填的夥伴 ID。換簽章要先拿掉舊的五參數版本（否則兩個版本並存，五個參數的呼叫會「不唯一」）
drop function if exists public.asn_chat_history(uuid, text, text, text, integer);

create or replace function public.asn_chat_history(p_user uuid, p_node text, p_partner_node text, p_partner_agent text, p_limit integer default 100, p_partner_id text default null::text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_tenant uuid;
  v_alias text := public.asn_person_alias(p_user);
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_pid text := null;
  v_out jsonb;
begin
  if not public.asn_user_owns_node(p_user, p_node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_partner_node is null or p_partner_node !~ '^[A-Za-z0-9_-]{1,32}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select tenant_id into v_tenant from relay.nodes where id = p_node;
  -- 夥伴 ID 只認同租戶的；不是就當沒帶（只用名字比對）
  if p_partner_id is not null and exists (select 1 from relay.partners p where p.partner_id = p_partner_id and p.tenant_id = v_tenant) then
    v_pid := p_partner_id;
  end if;
  select coalesce(jsonb_agg(x.j order by x.at, x.gid), '[]'::jsonb) into v_out from (
    select g.gid, g.at, jsonb_build_object(
        'id', g.gid, 'ids', g.ids, 'dir', g.dir, 'body', g.body, 'reply_to', g.reply_to,
        'created_at', g.at, 'delivered_at', g.delivered_at, 'acked_at', g.acked_at) as j
    from (
      select coalesce(m.fanout_id, m.id) as gid,
             (array_agg(m.id order by m.created_at, m.id))[1] as head,
             array_agg(m.id order by m.created_at, m.id) as ids,
             case when bool_or(m.from_agent = v_alias) then 'me' else 'them' end as dir,
             min(m.created_at) as at,
             (array_agg(m.body order by m.created_at, m.id))[1] as body,
             (array_agg(m.reply_to order by m.created_at, m.id))[1] as reply_to,
             min(m.delivered_at) as delivered_at,
             min(m.acked_at) as acked_at
      from relay.messages m
      where m.tenant_id = v_tenant
        and m.person_user = p_user
        and m.created_at > now() - interval '90 days'
        and (
          (m.from_agent = v_alias and m.to_node = p_partner_node and coalesce(m.to_agent, '') = coalesce(p_partner_agent, ''))
          or (m.from_agent is distinct from v_alias and m.from_node = p_partner_node and coalesce(m.from_agent, '') = coalesce(p_partner_agent, ''))
          or (v_pid is not null and m.from_agent = v_alias and m.to_partner_id = v_pid)
          or (v_pid is not null and m.from_agent is distinct from v_alias and m.from_partner_id = v_pid)
        )
      group by coalesce(m.fanout_id, m.id)
      order by min(m.created_at) desc, coalesce(m.fanout_id, m.id)
      limit v_limit
    ) g
  ) x;
  return jsonb_build_object('messages', v_out);
end;
$function$;

revoke all on function public.asn_chat_history(uuid, text, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.asn_chat_history(uuid, text, text, text, integer, text) to service_role;

-- 5. 名單：agents 每列多帶 partner_id（其餘與 20261022040000 完全相同）
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
        'partner_id', (select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name)) order by r.name)
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

commit;
