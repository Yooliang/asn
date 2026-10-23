-- 真人好友與群組 第 1a 期（後台）之一：資料表、欄位與內部輔助函式。規格見 docs/design/HUMANS-AND-GROUPS.md 第 0、2、7 節。
-- 只加欄、加表、加函式，不刪資料；舊群組（單一租戶）資料與行為不變。
-- 這一支與 20261023170100（改寫群組讀寫函式）、20261023170200（人的動作與主持人確認）要一起套用，順序固定；先套 migration，再部署 relay 函式。
-- 回復：supabase/sql/rollback/20261023170000_groups_p1a_down.sql。
begin;

-- ===== 群組與成員 =====
alter table relay.rooms add column if not exists created_by_user uuid;       -- 建立者（主持人）；舊群組為空，主持人以租戶擁有者代替
alter table relay.rooms add column if not exists origin jsonb;               -- 由一對一對話升級時的來源（節點、視窗名）
alter table relay.rooms add column if not exists member_cap integer not null default 30;

alter table relay.room_members add column if not exists member_ref uuid not null default gen_random_uuid(); -- 對外代號，不洩露節點代號與帳號 id
alter table relay.room_members add column if not exists user_id uuid;        -- 成員所屬的人（真人＝本人；AI＝它的主人）
alter table relay.room_members add column if not exists display_name text;
alter table relay.room_members add column if not exists visible_from_seq bigint not null default 0;
alter table relay.room_members add column if not exists allow_others boolean not null default true;
create unique index if not exists room_members_ref_key on relay.room_members (member_ref);

alter table relay.room_members drop constraint if exists room_members_joined_via_check;
alter table relay.room_members add constraint room_members_joined_via_check
  check (joined_via = any (array['auto','manual','create','invite','upgrade']));
alter table relay.room_members drop constraint if exists room_members_role_check;
alter table relay.room_members add constraint room_members_role_check
  check (role = any (array['owner','admin','member']));

-- ===== 群組訊息 =====
alter table relay.room_messages add column if not exists from_user uuid;
alter table relay.room_messages add column if not exists from_kind text;     -- human／ai／system；舊訊息為空，讀取時推算
alter table relay.room_messages add column if not exists is_seed boolean not null default false; -- 升級時複製的開頭紀錄
alter table relay.room_messages add column if not exists suppressed text[] not null default '{}'::text[]; -- 被點名但因額度或設定不叫醒的成員鍵
alter table relay.room_messages drop constraint if exists room_messages_from_kind_check;
alter table relay.room_messages add constraint room_messages_from_kind_check
  check (from_kind is null or from_kind = any (array['human','ai','system']));

-- ===== 邀請（一次性、24 小時；只存雜湊）=====
create table if not exists relay.person_invites (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  kind text not null check (kind in ('conversation', 'room')),
  room_id text references relay.rooms(id),
  source_node text,
  source_agent text,
  seed_count integer not null default 40 check (seed_count between 0 and 50),
  created_by_user uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  used_at timestamptz,
  used_by_user uuid,
  result_room text,
  revoked_at timestamptz,
  constraint person_invites_bind_check check (
    (kind = 'room' and room_id is not null) or (kind = 'conversation' and source_node is not null))
);
create index if not exists person_invites_creator_idx on relay.person_invites (created_by_user, created_at);

-- 接受邀請時碼錯誤的次數（每人每小時 20 次）
create table if not exists relay.invite_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  at timestamptz not null default now()
);
create index if not exists invite_attempts_idx on relay.invite_attempts (user_id, at);

-- 別人叫醒我的 AI 的紀錄（額度用）
create table if not exists relay.room_wakes (
  id bigint generated always as identity primary key,
  room_id text not null,
  target text not null,
  from_tenant uuid,
  at timestamptz not null default now()
);
create index if not exists room_wakes_idx on relay.room_wakes (target, at);

-- 危險操作確認請求與主持人確認紀錄
create table if not exists relay.room_confirms (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references relay.rooms(id),
  requester text not null,               -- 提出請求的 AI 成員鍵
  requester_user uuid,                   -- 該 AI 的主人
  host_user uuid not null,               -- 應確認的主持人
  kind text not null check (kind in ('data_change', 'deploy', 'spend', 'external_send', 'account_config', 'other')),
  summary text not null check (char_length(summary) between 1 and 500),
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  request_seq bigint,
  decision_seq bigint,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  decided_at timestamptz,
  decided_by_user uuid,
  signed boolean not null default false, -- 是否由主持人本人簽章（登入憑證）確認
  consumed_at timestamptz                -- 放行只能用一次
);
create index if not exists room_confirms_room_idx on relay.room_confirms (room_id, created_at);

alter table relay.person_invites enable row level security;
alter table relay.invite_attempts enable row level security;
alter table relay.room_wakes enable row level security;
alter table relay.room_confirms enable row level security;
revoke all on relay.person_invites, relay.invite_attempts, relay.room_wakes, relay.room_confirms from public, anon, authenticated;

-- ===== 內部輔助函式 =====

-- 成員鍵所屬的租戶：~owner＝群組建立地租戶；~u:<帳號>＝該帳號的租戶；其餘是節點或「節點~視窗」
create or replace function relay.member_tenant(p_key text, p_room_tenant uuid)
 returns uuid language sql stable security definer set search_path to ''
as $function$
  select case
    when p_key = '~owner' then p_room_tenant
    when p_key like '~u:%' then (select t.id from relay.tenants t where t.owner_user::text = substr(p_key, 4))
    else (select n.tenant_id from relay.nodes n where n.id = split_part(p_key, '~', 1))
  end;
$function$;

create or replace function relay.user_tenant(p_user uuid)
 returns uuid language sql stable security definer set search_path to ''
as $function$
  select t.id from relay.tenants t where t.owner_user = p_user;
$function$;

-- 本人簽章核對：簽章的人必須擁有這個節點，否則當作沒簽章
create or replace function relay.signed_user(p_node text, p_signed uuid)
 returns uuid language sql stable security definer set search_path to ''
as $function$
  select case when p_signed is not null and public.asn_user_owns_node(p_signed, p_node) then p_signed end;
$function$;

-- 這位呼叫者（節點金鑰＋本人簽章）在這個群組裡用哪個成員鍵：
-- 簽章過的本人且 ~u:<帳號> 是群組成員、沒指定視窗、不是舊後台路徑 → 本人的鍵；其餘照舊（room_caller_key）
create or replace function relay.room_actor_key(p_node text, p_agent text, p_owner boolean, p_signed uuid, p_room text)
 returns text language plpgsql stable security definer set search_path to ''
as $function$
declare v_u uuid := relay.signed_user(p_node, p_signed);
begin
  if v_u is not null and not coalesce(p_owner, false) and (p_agent is null or btrim(p_agent) = '')
     and relay.room_is_member(p_room, '~u:' || v_u::text) then
    return '~u:' || v_u::text;
  end if;
  return relay.room_caller_key(p_node, p_agent, p_owner);
end;
$function$;

-- 這個成員鍵能不能當作該群組的成員用：必須是有效成員；~owner 只限群組建立地租戶的節點
create or replace function relay.room_can(p_room text, p_node text, p_key text)
 returns boolean language sql stable security definer set search_path to ''
as $function$
  select p_key is not null and relay.room_is_member(p_room, p_key)
    and (p_key <> '~owner' or exists (
      select 1 from relay.rooms r where r.id = p_room and r.tenant_id is not distinct from relay.node_tenant(p_node)));
$function$;

-- 列表用：這一列成員是不是「我」（節點與其視窗、簽章過的本人；舊後台路徑則是 ~owner）
create or replace function relay.room_member_is_mine(p_member text, p_node text, p_owner boolean, p_user uuid, p_room_tenant uuid, p_node_tenant uuid)
 returns boolean language sql immutable set search_path to ''
as $function$
  select case
    when p_owner then p_member = '~owner' and p_room_tenant is not distinct from p_node_tenant
    else (p_member = p_node or left(p_member, char_length(p_node) + 1) = p_node || '~')
         or (p_user is not null and p_member = '~u:' || p_user::text)
  end;
$function$;

-- 對外成員鍵：同租戶回真實鍵（橋與手機靠它判斷是不是我）；別的租戶一律回 x:<member_ref>，不洩露節點代號與帳號 id
create or replace function relay.room_ext_key(p_room text, p_key text, p_reader_tenant uuid, p_room_tenant uuid)
 returns text language sql stable security definer set search_path to ''
as $function$
  select case
    when p_key is null then null
    when relay.member_tenant(p_key, p_room_tenant) is not distinct from p_reader_tenant then p_key
    else coalesce((select 'x:' || m.member_ref::text from relay.room_members m where m.room_id = p_room and m.member = p_key), 'x:unknown')
  end;
$function$;

-- 收到的成員鍵（可能是對外代號 x:<ref>）還原成真實鍵；找不到回 null
create or replace function relay.room_resolve_key(p_room text, p_key text)
 returns text language sql stable security definer set search_path to ''
as $function$
  select case
    when p_key like 'x:%' then (select m.member from relay.room_members m
        where m.room_id = p_room and m.member_ref::text = substr(p_key, 3))
    else p_key
  end;
$function$;

-- 群組內的顯示名：成員表的 display_name；沒有就推算（真人＝帳號名；視窗＝視窗名；節點＝節點名）
create or replace function relay.room_display_name(p_room text, p_key text)
 returns text language sql stable security definer set search_path to ''
as $function$
  select coalesce(
    (select nullif(btrim(m.display_name), '') from relay.room_members m where m.room_id = p_room and m.member = p_key),
    case
      when p_key = '~owner' or p_key like '~u:%' then
        coalesce((select t.owner_name from relay.tenants t
                  where t.id = relay.member_tenant(p_key, (select r.tenant_id from relay.rooms r where r.id = p_room))), '帳號擁有者')
      when position('~' in p_key) > 0 then substr(p_key, position('~' in p_key) + 1)
      else coalesce((select n.name from relay.nodes n where n.id = p_key), p_key)
    end);
$function$;

create or replace function relay.room_owner_name(p_key text, p_room_tenant uuid)
 returns text language sql stable security definer set search_path to ''
as $function$
  select (select t.owner_name from relay.tenants t where t.id = relay.member_tenant(p_key, p_room_tenant));
$function$;

-- 訊息寄件者種類：人（~owner、~u:、或本人簽章的訊息）／AI／系統
create or replace function relay.msg_kind(p_from_kind text, p_from text, p_trust text)
 returns text language sql immutable set search_path to ''
as $function$
  select coalesce(p_from_kind, case when p_from = '~owner' or p_from like '~u:%' or p_trust = 'owner' then 'human' else 'ai' end);
$function$;

-- 寫入一則群組訊息（發言、系統訊息、開頭紀錄、確認訊息共用）；回新序號
create or replace function relay.room_append(
  p_room text, p_from text, p_trust text, p_body text, p_mentions text[], p_kind text, p_seed boolean, p_user uuid,
  p_at timestamptz default now(), p_suppressed text[] default '{}'::text[])
 returns bigint language plpgsql security definer set search_path to ''
as $function$
declare v_seq bigint;
begin
  update relay.rooms set last_seq = last_seq + 1 where id = p_room returning last_seq into v_seq;
  insert into relay.room_messages (room_id, seq, from_member, trust, body, mentions, at, from_user, from_kind, is_seed, suppressed)
    values (p_room, v_seq, p_from, p_trust, p_body, coalesce(p_mentions, '{}'), p_at, p_user, p_kind, coalesce(p_seed, false), coalesce(p_suppressed, '{}'));
  return v_seq;
end;
$function$;

-- 群組裡有沒有別的租戶的成員（有就禁止傳附件）
create or replace function relay.room_has_external(p_room text)
 returns boolean language sql stable security definer set search_path to ''
as $function$
  select (select count(distinct relay.member_tenant(m.member, r.tenant_id))
          from relay.room_members m join relay.rooms r on r.id = m.room_id
          where m.room_id = p_room and m.left_at is null) > 1;
$function$;

-- 群組所有成員節點的門鈴頻道（不分租戶；~u:<帳號> 響該帳號所有有效節點）
create or replace function relay.room_bells(p_room text)
 returns text[] language sql stable security definer set search_path to ''
as $function$
  select coalesce(array_agg(distinct n.bell_topic), array[]::text[])
  from relay.room_members rm
  join relay.nodes n on n.status = 'active' and (
       (rm.member not like '~%' and n.id = split_part(rm.member, '~', 1))
    or (rm.member like '~u:%' and n.owner_user::text = substr(rm.member, 4)))
  where rm.room_id = p_room and rm.left_at is null;
$function$;

-- 主持人（群組主人）：建立者；舊群組沒有記建立者時以建立地租戶的擁有者代替
create or replace function relay.room_host(p_room text)
 returns uuid language sql stable security definer set search_path to ''
as $function$
  select coalesce(r.created_by_user, (select t.owner_user from relay.tenants t where t.id = r.tenant_id))
  from relay.rooms r where r.id = p_room;
$function$;

-- 這個人是不是群組的真人成員（~u:<帳號>，或舊群組中屬於建立地租戶本人的 ~owner）；回成員鍵
create or replace function relay.room_human_member(p_room text, p_user uuid)
 returns text language sql stable security definer set search_path to ''
as $function$
  select m.member from relay.room_members m join relay.rooms r on r.id = m.room_id
  where m.room_id = p_room and m.left_at is null and r.archived_at is null
    and (m.member = '~u:' || p_user::text
         or (m.member = '~owner' and exists (select 1 from relay.tenants t where t.id = r.tenant_id and t.owner_user = p_user)))
  order by (m.member like '~u:%') desc limit 1;
$function$;

-- 被別人點名的 AI 的額度與設定：回「不該叫醒」的成員鍵（超過每群組每小時 10 次、跨群組每小時 30 次、或主人關掉接受別人點名）
-- 同租戶（自己或自己主人的 AI）不限。符合要叫醒的順便記一筆。
create or replace function relay.room_wake_filter(p_room text, p_sender_tenant uuid, p_room_tenant uuid, p_mentions text[])
 returns text[] language plpgsql security definer set search_path to ''
as $function$
declare
  k text;
  v_out text[] := '{}';
begin
  foreach k in array coalesce(p_mentions, '{}') loop
    if k = '~owner' or k like '~u:%' then continue; end if;
    if relay.member_tenant(k, p_room_tenant) is not distinct from p_sender_tenant then continue; end if;
    if exists (select 1 from relay.room_members m where m.room_id = p_room and m.member = k and not m.allow_others)
       or (select count(*) from relay.room_wakes w where w.target = k and w.room_id = p_room and w.at > now() - interval '1 hour') >= 10
       or (select count(*) from relay.room_wakes w where w.target = k and w.at > now() - interval '1 hour') >= 30 then
      v_out := v_out || k;
    else
      insert into relay.room_wakes (room_id, target, from_tenant) values (p_room, k, p_sender_tenant);
    end if;
  end loop;
  return v_out;
end;
$function$;

-- 成員清單（對讀者）：自己租戶的成員給完整欄位（與舊版相同並多幾欄）；別人的只給顯示用欄位與對外代號
create or replace function relay.room_members_view(p_room text, p_reader uuid)
 returns jsonb language sql stable security definer set search_path to ''
as $function$
  select coalesce(jsonb_agg(
    case when x.mt is not distinct from p_reader then jsonb_build_object(
      'key', x.member,
      'name', relay.room_display_name(p_room, x.member),
      'role', x.role,
      'kind', case when x.member = '~owner' or x.member like '~u:%' then 'owner'
                   when position('~' in x.member) > 0 then 'window'
                   else coalesce(x.nkind, 'other') end,
      'node_role', case when x.member = '~owner' or x.member like '~u:%' then 'owner' else coalesce(x.nrole, 'member') end,
      'joined_via', x.joined_via,
      'member_kind', case when x.member = '~owner' or x.member like '~u:%' then 'human' else 'ai' end,
      'owner_name', relay.room_owner_name(x.member, x.rt),
      'label', case when x.member = '~owner' or x.member like '~u:%' then relay.room_display_name(p_room, x.member)
                    else relay.room_display_name(p_room, x.member) || '（' || coalesce(relay.room_owner_name(x.member, x.rt), '?') || '）' end,
      'mine', true)
    else jsonb_build_object(
      'key', 'x:' || x.member_ref::text,
      'name', relay.room_display_name(p_room, x.member),
      'role', x.role,
      'kind', case when x.member = '~owner' or x.member like '~u:%' then 'human' else 'ai' end,
      'member_kind', case when x.member = '~owner' or x.member like '~u:%' then 'human' else 'ai' end,
      'owner_name', relay.room_owner_name(x.member, x.rt),
      'label', case when x.member = '~owner' or x.member like '~u:%' then relay.room_display_name(p_room, x.member)
                    else relay.room_display_name(p_room, x.member) || '（' || coalesce(relay.room_owner_name(x.member, x.rt), '?') || '）' end,
      'mine', false)
    end order by x.joined_at, x.member), '[]'::jsonb)
  from (
    select m.member, m.member_ref, m.role, m.joined_at, m.joined_via, r.tenant_id as rt,
           relay.member_tenant(m.member, r.tenant_id) as mt, n.kind as nkind, n.role as nrole
    from relay.room_members m
    join relay.rooms r on r.id = m.room_id
    left join relay.nodes n on n.id = split_part(m.member, '~', 1) and m.member not like '~%'
    where m.room_id = p_room and m.left_at is null
  ) x;
$function$;

commit;
