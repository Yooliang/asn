-- 網頁版第 0 階段的後台地基（#1751）：網頁用「登入身分」，不持有長期金鑰，只能做明確列入的動作。
-- 這支 migration 做的事：
--  1. 新表 relay.web_sessions：記每個網頁登入（哪個帳號、Supabase 的 session_id、瀏覽器代號的雜湊、瀏覽器摘要、第一次與最後使用、登出時間）。開 RLS、不建 policy。
--  2. relay.nodes 可以放網頁節點：kind='web'、platform='web'、created_via='web-login'；key_hash 一律是 'web:' 開頭的佔位值（永遠比對不到真的金鑰雜湊）。
--     兩個方向都有檢查式：網頁節點一定是佔位值，真設備的 key_hash 不可能是 'web:' 開頭。device_keys.platform 也多收 'web'。
--  3. 每個帳號最多 10 個有效的網頁節點（asn_relay_web_touch）。網頁節點不佔真設備的 20 台名額（node_create、cloud_node_create、device_code_approve）。
--  4. asn_relay_send_core：網頁走獨立路線，不進「在線 ASN」的分送名單。網頁開著不改變手機與電腦的收信（沒有回報 platform 的舊手機照樣收得到）；
--     開著的網頁另外多收一列，寄件名單與推播判斷都不看網頁。
--  5. 網頁不收的通知種類（登入、等待確認、設備金鑰、看畫面）：asn_relay_send_notice 寄出後刪掉給網頁的列、不敲網頁的門鈴；asn_chat_history 對網頁節點再過濾一次。
--  6. 其他挑節點的函式排除網頁：asn_relay_inbox_watch、asn_relay_list（多選填參數 p_include_web，預設 false）、asn_setup_request、asn_relay_setup_poll、
--     asn_update_request、asn_account_nodes、perm_req／secret 與群組的門鈴。
--  7. 新函式：asn_relay_web_touch（驗證並登記網頁登入）、asn_relay_web_session_is_web、asn_relay_web_sessions_list、asn_relay_web_logout_all、relay.web_lane_targets、relay.web_denied_notice、relay.web_browser_label。
--  8. 清理：登出紀錄保留 90 天供稽核，之後刪除（asn_relay_web_sessions_purge，每天 03:47 UTC 由 pg_cron 執行）。沒登出的、90 天內登出的都不動；已撤銷的網頁節點本身留著（信件掛在上面）。
-- 全部是新增或「多排除網頁」，舊用戶端與舊 Edge 不受影響。函式都是 security definer、search_path 空、只授權 service_role。
-- 回復：supabase/sql/rollback/20261119200000_web_sessions_down.sql（上面各函式換回原文、拿掉新表與新函式；已有的網頁節點改成已撤銷的一般節點，信件不動）。
begin;

-- ===== 資料表與檢查式 =====
alter table relay.nodes drop constraint if exists nodes_platform_check;
alter table relay.nodes add constraint nodes_platform_check check (platform is null or platform in ('linux', 'windows', 'macos', 'android', 'ios', 'web'));
alter table relay.nodes drop constraint if exists nodes_created_via_check;
alter table relay.nodes add constraint nodes_created_via_check
  check (created_via is null or created_via in ('login-device', 'claim-existing', 'cloud-invite', 'device-code', 'web-login'));
alter table relay.device_keys drop constraint if exists device_keys_platform_check;
alter table relay.device_keys add constraint device_keys_platform_check check (platform is null or platform = any (array['desktop', 'android', 'web']));
-- 網頁節點的 key_hash 一律是 'web:' 佔位值；真設備不可能用這個開頭。兩個方向都鎖住
alter table relay.nodes drop constraint if exists nodes_web_check;
alter table relay.nodes add constraint nodes_web_check check (
  (coalesce(kind, '') = 'web') = (key_hash like 'web:%')
  and (coalesce(kind, '') <> 'web' or (coalesce(created_via, '') = 'web-login' and coalesce(platform, '') = 'web' and role = 'member' and device_id is null)));

create table if not exists relay.web_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  session_id uuid not null,
  device_hash text not null,
  node_id text not null references relay.nodes (id) on delete cascade,
  browser text not null default '',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  signed_out_at timestamptz,
  constraint web_sessions_session_key unique (session_id),
  constraint web_sessions_device_check check (device_hash ~ '^[0-9a-f]{64}$')
);
create index if not exists web_sessions_user_idx on relay.web_sessions (user_id, device_hash);
create index if not exists web_sessions_node_idx on relay.web_sessions (node_id);
alter table relay.web_sessions enable row level security;
revoke all on relay.web_sessions from public, anon, authenticated;

-- ===== 小工具 =====
-- 網頁不收的通知種類
create or replace function relay.web_denied_notice(p_kind text)
 returns boolean language sql immutable set search_path to ''
as $function$
  select p_kind in ('notice:login', 'notice:waiting', 'notice:device_key', 'notice:view');
$function$;
revoke all on function relay.web_denied_notice(text) from public, anon, authenticated;

-- 瀏覽器摘要：去控制字元與改變文字方向的字元、壓縮空白、限 40 字；空的給預設
create or replace function relay.web_browser_label(p_label text)
 returns text language sql immutable set search_path to ''
as $function$
  select coalesce(nullif(btrim(left(regexp_replace(regexp_replace(coalesce(p_label, ''), '[[:cntrl:]]', ' ', 'g'),
    '[\u200e\u200f\u202a-\u202e\u2066-\u2069]', '', 'g'), 40)), ''), '瀏覽器');
$function$;
revoke all on function relay.web_browser_label(text) from public, anon, authenticated;

-- 網頁車道的收件列：同帳號、開著（3 分鐘內有回報在線）的網頁節點，最多 10 個，不含寄件人自己
create or replace function relay.web_lane_targets(p_tenant uuid, p_owner uuid, p_from text)
 returns jsonb language sql stable security definer set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object('node', t.id, 'bell', t.bell_topic) order by t.id), '[]'::jsonb)
  from (
    select n.id, n.bell_topic from relay.nodes n
     where n.tenant_id = p_tenant and n.status = 'active' and n.owner_user = p_owner and n.kind = 'web' and n.id <> p_from
       and exists (select 1 from relay.asn_presence p where p.node = n.id and p.updated_at > now() - interval '3 minutes')
     order by n.id limit 10
  ) t;
$function$;
revoke all on function relay.web_lane_targets(uuid, uuid, text) from public, anon, authenticated;

-- ===== 網頁登入 =====
-- 驗證並登記一個網頁登入。身分（使用者與 session_id）由 Edge 驗過登入憑證才傳進來。
--   已登記：使用者與瀏覽器代號都要對得上，沒登出才算數；每次呼叫更新最後使用時間（30 秒內不重寫）。
--   沒登記：p_create 為真才建立（網頁節點＋登入記錄）；每個帳號最多 10 個有效的網頁節點；同一個瀏覽器第一次出現時寄信給本人。
create or replace function public.asn_relay_web_touch(p_user uuid, p_session uuid, p_device_hash text, p_label text, p_create boolean default true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_s relay.web_sessions%rowtype;
  v_n relay.nodes%rowtype;
  v_t relay.tenants%rowtype;
  v_id text;
  v_label text;
  v_first boolean;
  v_tries int := 0;
  v_topic text;
  v_res jsonb;
  v_notice jsonb := null;
begin
  if p_user is null or p_session is null or p_device_hash is null or p_device_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  perform pg_advisory_xact_lock(hashtext('web_touch:' || p_user::text));
  select * into v_s from relay.web_sessions where session_id = p_session for update;
  if found then
    if v_s.user_id <> p_user or v_s.device_hash <> p_device_hash then
      return jsonb_build_object('error', 'forbidden');
    end if;
    if v_s.signed_out_at is not null then
      return jsonb_build_object('error', 'signed_out');
    end if;
    select * into v_n from relay.nodes where id = v_s.node_id;
    if not found or v_n.status <> 'active' then
      return jsonb_build_object('error', 'signed_out');
    end if;
    if v_s.last_seen_at < now() - interval '30 seconds' then
      update relay.web_sessions set last_seen_at = now() where id = v_s.id;
      update relay.nodes set last_seen_at = now() where id = v_n.id;
    end if;
    return jsonb_build_object('node', jsonb_build_object('id', v_n.id, 'bell_topic', v_n.bell_topic, 'role', v_n.role, 'tenant_id', v_n.tenant_id), 'created', false);
  end if;
  if not coalesce(p_create, false) then
    return jsonb_build_object('error', 'unknown');
  end if;
  v_t := relay.asn_ensure_tenant(p_user, null);
  if v_t.status <> 'active' then
    return jsonb_build_object('error', 'tenant_inactive');
  end if;
  if (select count(*) from relay.nodes where owner_user = p_user and status = 'active' and kind = 'web') >= 10 then
    return jsonb_build_object('error', 'too_many');
  end if;
  v_label := relay.web_browser_label(p_label);
  v_first := not exists (select 1 from relay.web_sessions where user_id = p_user and device_hash = p_device_hash);
  v_topic := 'relay-bell-' || replace(gen_random_uuid()::text, '-', '') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  loop
    v_id := coalesce(v_t.id_prefix, 'n') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
    begin
      insert into relay.nodes (id, name, key_hash, bell_topic, kind, role, can_invite, can_roster, machine, status, last_seen_at, tenant_id, owner_user, platform, created_via)
        values (v_id, v_label, 'web:' || gen_random_uuid()::text, v_topic, 'web', 'member', false, false, v_label, 'active', now(), v_t.id, p_user, 'web', 'web-login');
      exit;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries >= 5 then
        return jsonb_build_object('error', 'internal');
      end if;
    end;
  end loop;
  insert into relay.web_sessions (user_id, session_id, device_hash, node_id, browser) values (p_user, p_session, p_device_hash, v_id, v_label);
  insert into relay.account_events (user_id, event, node) values (p_user, 'web_login', v_id);
  if v_first then
    -- 新瀏覽器第一次登入：寄一封通知給本人（寄不出去不影響登入）
    begin
      v_res := public.asn_relay_send_notice(v_id, 'web_login',
        '新的瀏覽器登入' || E'\n' || '瀏覽器：' || v_label || E'\n' || '時間：' || to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') || '（台北時間）' || E'\n'
        || '如果不是你，請到設備頁登出所有網頁。', 3, interval '1 hour');
      v_notice := jsonb_build_object('notify', coalesce(v_res ->> 'notify', 'failed'), 'bell_topics', coalesce(v_res -> 'bell_topics', '[]'::jsonb), 'mail_id', v_res -> 'send' -> 'id');
    exception when others then
      raise warning 'web_touch: notice failed: %', sqlerrm;
      v_notice := jsonb_build_object('notify', 'failed', 'bell_topics', '[]'::jsonb);
    end;
  end if;
  return jsonb_build_object('node', jsonb_build_object('id', v_id, 'bell_topic', v_topic, 'role', 'member', 'tenant_id', v_t.id),
    'created', true, 'first', v_first, 'notice', v_notice);
end;
$function$;
revoke all on function public.asn_relay_web_touch(uuid, uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_web_touch(uuid, uuid, text, text, boolean) to service_role;

-- 這個 session 是不是網頁登入（登出過的也算；給 Edge 擋「網頁憑證不經網頁路線」）
create or replace function public.asn_relay_web_session_is_web(p_session uuid)
 returns boolean language sql stable security definer set search_path to ''
as $function$
  select p_session is not null and exists (select 1 from relay.web_sessions where session_id = p_session);
$function$;
revoke all on function public.asn_relay_web_session_is_web(uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_web_session_is_web(uuid) to service_role;

-- 這個帳號的網頁登入清單（不含瀏覽器代號雜湊）
create or replace function public.asn_relay_web_sessions_list(p_user uuid, p_session uuid default null)
 returns jsonb language sql stable security definer set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object('node', s.node_id, 'browser', s.browser, 'first_seen_at', s.first_seen_at,
           'last_seen_at', s.last_seen_at, 'signed_out_at', s.signed_out_at, 'current', s.session_id = p_session)
           order by s.last_seen_at desc), '[]'::jsonb)
  from (select * from relay.web_sessions where user_id = p_user order by last_seen_at desc limit 50) s;
$function$;
revoke all on function public.asn_relay_web_sessions_list(uuid, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_web_sessions_list(uuid, uuid) to service_role;

-- 登出這個帳號所有網頁：登入記錄標登出、網頁節點標撤銷。回網頁節點的門鈴讓開著的頁面知道
create or replace function public.asn_relay_web_logout_all(p_user uuid)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_nodes text[];
  v_topics jsonb;
begin
  if p_user is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  perform pg_advisory_xact_lock(hashtext('web_touch:' || p_user::text));
  select coalesce(array_agg(node_id), array[]::text[]) into v_nodes from relay.web_sessions where user_id = p_user and signed_out_at is null;
  update relay.web_sessions set signed_out_at = now() where user_id = p_user and signed_out_at is null;
  select coalesce(jsonb_agg(n.bell_topic), '[]'::jsonb) into v_topics from relay.nodes n where n.id = any(v_nodes);
  update relay.nodes set status = 'revoked' where id = any(v_nodes) and kind = 'web';
  insert into relay.account_events (user_id, event, detail) values (p_user, 'web_logout_all', jsonb_build_object('count', coalesce(array_length(v_nodes, 1), 0)));
  return jsonb_build_object('count', coalesce(array_length(v_nodes, 1), 0), 'bell_topics', v_topics);
end;
$function$;
revoke all on function public.asn_relay_web_logout_all(uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_web_logout_all(uuid) to service_role;

-- ===== 既有函式：網頁走獨立路線、或多排除網頁（其餘一個字不動）=====

CREATE OR REPLACE FUNCTION public.asn_relay_send_core(p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid, p_expects_reply boolean DEFAULT NULL::boolean, p_signed_user uuid DEFAULT NULL::uuid, p_as_person boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_topic text;
  v_id uuid;
  v_recent int;
  v_tenant uuid;
  v_to text := p_to_node;
  v_signed boolean := public.asn_user_owns_node(p_signed_user, p_from_node);
  v_owner uuid;
  v_alias text;
  v_person boolean := false;
  v_from_agent text := p_from_agent;
  v_person_user uuid := null;
  v_targets jsonb;
  v_phones jsonb;
  v_t jsonb;
  v_bells text[] := array[]::text[];
  v_head uuid;
  v_n int := 0;
begin
  if p_body is null or char_length(p_body) < 1 or char_length(p_body) > 20000 then
    return jsonb_build_object('error', 'bad_body');
  end if;
  select tenant_id into v_tenant from relay.nodes where id = p_from_node;
  select owner_user into v_owner from relay.tenants where id = v_tenant;
  v_alias := public.asn_person_alias(v_owner);
  -- 舊寫法相容：Irori 時代的角色節點 XISU 已拿掉。節點不存在時，寄給「XISU」「XISU/u:xxxx」（沒指定視窗或指定本人代號）一律視同寄給本人位址。
  if p_to_node = 'XISU' and not exists (select 1 from relay.nodes where id = 'XISU')
     and (p_to_agent is null or p_to_agent = '' or p_to_agent ~ '^u:[0-9a-f]{12}$') then
    if v_alias is null then
      return jsonb_build_object('error', 'unknown_to_node');
    end if;
    p_to_node := v_alias;
  end if;

  -- 與節點無關的本人位址：to_node 直接寫人代號（例如 u:3cda66252c34）。只認這個租戶擁有者的代號；
  -- 視同「寄給人代號」，後面走同一條扇出。舊寫法「節點/u:xxx」（含 XISU/u:xxx）不經過這裡，照舊可用。
  if p_to_node ~ '^u:[0-9a-f]{12}$' then
    if v_alias is null or p_to_node <> v_alias then
      return jsonb_build_object('error', 'unknown_to_node');
    end if;
    p_to_agent := v_alias;
    select coalesce(
        (select t.character_node from relay.tenants t where t.id = v_tenant),
        (select o.id from relay.nodes o where o.tenant_id = v_tenant and o.role = 'owner' and o.status = 'active' limit 1),
        (select n.id from relay.nodes n where n.tenant_id = v_tenant and n.status = 'active' and n.owner_user = v_owner and coalesce(n.kind, '') <> 'web' order by n.created_at limit 1))
      into v_to;
  end if;

  -- 保底（角色節點不再當本人的信箱）：寄給租戶「本人的角色節點」（租戶主節點 role=owner，或租戶設定的角色節點，例如 XISU）、
  -- 且沒指定視窗（或指定的就是本人代號），而那個節點上沒有在線的 ASN 視窗 → 一律改寄本人位址，照常扇出到本人各 ASN 視窗。
  -- 舊用戶端（舊橋、舊外掛、舊 AI 技能）照舊信頭只寫節點代號回信時也到得了本人。
  -- 不動的情形：指定了別的視窗名、節點上有在線的 ASN（那是真的設備）、寄件人就是該節點自己、不同租戶。
  if v_alias is not null and v_owner is not null
     and (p_to_agent is null or p_to_agent = '' or p_to_agent = v_alias)
     and v_to is distinct from p_from_node
     and exists (
       select 1 from relay.nodes rn
       where rn.id = v_to and rn.tenant_id = v_tenant and rn.status = 'active'
         and (rn.role = 'owner' or rn.id = (select t.character_node from relay.tenants t where t.id = v_tenant)))
     and not exists (
       select 1 from relay.asn_presence ap
       where ap.node = v_to and ap.updated_at > now() - interval '3 minutes') then
    p_to_agent := v_alias;
  end if;

  -- 以「人」寄出：要有效的本人簽章、簽章的人就是租戶擁有者；收件人若是同帳號的 ASN 視窗（設備互聊）仍用原本的視窗名
  if coalesce(p_as_person, false) and v_signed and v_owner is not null and p_signed_user = v_owner
     and p_to_agent is distinct from v_alias
     and not exists (select 1 from relay.asn_presence ap where ap.node = v_to and ap.window_name = p_to_agent) then
    v_person := true;
    v_from_agent := v_alias;
    v_person_user := v_owner;
  end if;

  select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
    where from_node = p_from_node and created_at > now() - interval '1 minute';

  if p_reply_to is not null and not exists (
    select 1 from relay.messages where id = p_reply_to and tenant_id is not distinct from v_tenant
  ) then
    p_reply_to := null;
  end if;

  -- 寄給人代號（AI 回信）：扇出給此帳號每個在線的 ASN 視窗
  if not v_person and v_owner is not null and p_to_agent = v_alias then
    if v_recent >= 30 then
      return jsonb_build_object('error', 'rate_limited');
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('node', t.node, 'agent', t.window_name, 'bell', t.bell_topic)
             order by t.is_first desc, t.updated_at desc, t.node, t.window_name), '[]'::jsonb)
      into v_targets
      from (
        select p.node, p.window_name, n.bell_topic, p.updated_at, (p.node = v_to) as is_first
        from relay.asn_presence p join relay.nodes n on n.id = p.node
        where n.tenant_id = v_tenant and n.status = 'active' and n.owner_user = v_owner
          and coalesce(n.kind, '') <> 'web'
          and p.updated_at > now() - interval '3 minutes'
        order by (p.node = v_to) desc, p.updated_at desc, p.node, p.window_name
        limit 10
      ) t;
    -- 手機沒開 App 時也留一列，開 App 照一般信收到、算未讀。只認回報過平台的手機（認不出來的照舊），30 天內開過才算，積信有上限
    select coalesce(jsonb_agg(jsonb_build_object('node', t.node, 'agent', t.window_name, 'bell', t.bell_topic) order by t.node), '[]'::jsonb)
      into v_phones
      from (
        select distinct on (p.node) p.node, p.window_name, n.bell_topic
        from relay.asn_presence p join relay.nodes n on n.id = p.node
        where n.tenant_id = v_tenant and n.status = 'active' and n.owner_user = v_owner
          and n.platform in ('android', 'ios')
          and p.updated_at > now() - interval '30 days'
          and not exists (select 1 from relay.asn_presence q where q.node = p.node and q.updated_at > now() - interval '3 minutes')
          and (select count(*) from (select 1 from relay.messages m where m.to_node = p.node and m.acked_at is null and m.to_agent is distinct from v_alias limit 100) c) < 100
        order by p.node, p.updated_at desc
        limit 5
      ) t;
    if jsonb_array_length(v_targets) = 0 then
      -- 沒有在線的 ASN：留一列（原收件節點；它不在了就挑帳號名下最早的節點），人打開 ASN 時從往來記錄補看
      select n.bell_topic, n.id into v_topic, v_to
        from relay.nodes n
        where n.tenant_id = v_tenant and n.status = 'active' and coalesce(n.kind, '') <> 'web'
          and (n.id = v_to or n.owner_user = v_owner)
        order by (n.id = v_to) desc, n.created_at limit 1;
      if v_topic is null then
        return jsonb_build_object('error', 'unknown_to_node');
      end if;
      insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply, owner_signed, person_user)
        values (p_from_node, v_from_agent, v_to, p_to_agent, p_body, p_reply_to, v_tenant, p_expects_reply, v_signed, v_owner)
        returning id into v_id;
      v_bells := array[v_topic];
      for v_t in select value from jsonb_array_elements(v_phones) loop
        update relay.messages set fanout_id = v_id where id = v_id and fanout_id is null;
        insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply, owner_signed, person_user, fanout_id)
          values (p_from_node, v_from_agent, v_t->>'node', v_t->>'agent', p_body, p_reply_to, v_tenant, p_expects_reply, v_signed, v_owner, v_id);
        if not (v_t->>'bell' = any(v_bells)) then v_bells := v_bells || (v_t->>'bell'); end if;
      end loop;
      -- 網頁走獨立路線：不影響上面「有沒有在線設備」的判斷，只是另外多留一列給開著的網頁
      for v_t in select value from jsonb_array_elements(relay.web_lane_targets(v_tenant, v_owner, p_from_node)) loop
        update relay.messages set fanout_id = v_id where id = v_id and fanout_id is null;
        insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply, owner_signed, person_user, fanout_id)
          values (p_from_node, v_from_agent, v_t->>'node', 'web', p_body, p_reply_to, v_tenant, p_expects_reply, v_signed, v_owner, v_id);
        if not (v_t->>'bell' = any(v_bells)) then v_bells := v_bells || (v_t->>'bell'); end if;
      end loop;
      return jsonb_build_object('id', v_id, 'bell_topic', v_topic, 'bell_topics', to_jsonb(v_bells), 'fanout', 0);
    end if;
    v_targets := v_targets || v_phones;
    for v_t in select value from jsonb_array_elements(v_targets) loop
      insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply, owner_signed, person_user, fanout_id)
        values (p_from_node, v_from_agent, v_t->>'node', v_t->>'agent', p_body, p_reply_to, v_tenant, p_expects_reply, v_signed, v_owner, v_head)
        returning id into v_id;
      if v_head is null then
        v_head := v_id;
        update relay.messages set fanout_id = v_head where id = v_head;
      end if;
      v_n := v_n + 1;
      if not (v_t->>'bell' = any(v_bells)) then v_bells := v_bells || (v_t->>'bell'); end if;
    end loop;
    -- 網頁走獨立路線：不進上面的分送名單，不當頭一列，也不算進 fanout
    for v_t in select value from jsonb_array_elements(relay.web_lane_targets(v_tenant, v_owner, p_from_node)) loop
      insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply, owner_signed, person_user, fanout_id)
        values (p_from_node, v_from_agent, v_t->>'node', 'web', p_body, p_reply_to, v_tenant, p_expects_reply, v_signed, v_owner, v_head);
      if not (v_t->>'bell' = any(v_bells)) then v_bells := v_bells || (v_t->>'bell'); end if;
    end loop;
    return jsonb_build_object('id', v_head, 'bell_topic', v_bells[1], 'bell_topics', to_jsonb(v_bells), 'fanout', v_n);
  end if;

  -- 一般寄信（與上一版相同；人寄出時多記 person_user、換寄件視窗名）
  select bell_topic into v_topic from relay.nodes
    where id = v_to and status = 'active' and tenant_id is not distinct from v_tenant;
  if v_topic is null then
    return jsonb_build_object('error', 'unknown_to_node');
  end if;
  if v_recent >= 30 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply, owner_signed, person_user)
    values (p_from_node, v_from_agent, v_to, p_to_agent, p_body, p_reply_to, v_tenant, p_expects_reply, v_signed, v_person_user)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

create or replace function public.asn_relay_send_notice(p_node text, p_topic text, p_body text, p_limit integer default 3, p_window interval default interval '1 hour')
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_owner uuid;
  v_kind text;
  v_recent int;
  v_res jsonb;
  v_id uuid;
  v_topics jsonb := '[]'::jsonb;
  v_agent constant text := 'ASN 通知';
begin
  if p_topic is null or p_topic !~ '^[a-z_]{1,30}$'
     or p_limit is null or p_limit < 1 or p_limit > 1000
     or p_window is null or p_window <= interval '0' or p_window > interval '7 days' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 內文長度規則與 asn_relay_send_core 相同（1～20000 字）
  if p_body is null or char_length(p_body) < 1 or char_length(p_body) > 20000 then
    return jsonb_build_object('error', 'bad_body');
  end if;
  v_kind := 'notice:' || p_topic;
  select owner_user into v_owner from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if v_owner is null or not public.asn_user_owns_node(v_owner, p_node) then
    return jsonb_build_object('ok', true, 'notify', 'skipped', 'bell_topics', '[]'::jsonb);
  end if;
  perform pg_advisory_xact_lock(hashtext('notice:' || p_node || ':' || v_kind));
  -- 限流看「節點＋種類＋時間窗」，與寄件名無關
  select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
    where from_node = p_node and kind = v_kind and created_at > now() - p_window;
  if v_recent >= p_limit then
    return jsonb_build_object('ok', true, 'notify', 'rate_limited', 'bell_topics', '[]'::jsonb);
  end if;
  v_res := public.asn_relay_send(p_node, v_agent, public.asn_person_alias(v_owner), null, p_body, null, false, null, false);
  if v_res is null or v_res ? 'error' then
    return jsonb_build_object('ok', true, 'notify', 'failed', 'bell_topics', '[]'::jsonb, 'send', v_res);
  end if;
  -- 同一次寄出的每一列（含分送給各設備的列）都標上種類；kind 只在這裡寫入
  -- 用寄信結果的 id 精確定位：分送給各設備時 id 是第一列、其餘列的 fanout_id 等於它。
  -- asn_relay_send_core 成功時一定回 id；萬一沒有，就丟例外讓整筆寄送跟著回滾，不留下沒有 kind 的通知
  v_id := nullif(coalesce(v_res ->> 'id', v_res ->> 'fanout_id'), '')::uuid;
  if v_id is null then
    raise exception 'asn_relay_send_notice: send result has no id';
  end if;
  update relay.messages set kind = v_kind
    where from_node = p_node and kind is null and (id = v_id or fanout_id = v_id);
  v_topics := case
    when jsonb_typeof(v_res -> 'bell_topics') = 'array' then v_res -> 'bell_topics'
    when jsonb_typeof(v_res -> 'bell_topic') = 'string' then jsonb_build_array(v_res -> 'bell_topic')
    else '[]'::jsonb end;
  -- 網頁不收的種類：同一次寄出裡給網頁的列刪掉，門鈴也不敲網頁
  if relay.web_denied_notice(v_kind) then
    delete from relay.messages m using relay.nodes wn
      where wn.id = m.to_node and wn.kind = 'web' and m.from_node = p_node and m.kind = v_kind and (m.id = v_id or m.fanout_id = v_id);
    v_topics := coalesce((select jsonb_agg(e.t) from jsonb_array_elements_text(v_topics) as e(t)
                           where not exists (select 1 from relay.nodes wn where wn.kind = 'web' and wn.bell_topic = e.t)), '[]'::jsonb);
    v_res := v_res || jsonb_build_object('bell_topics', v_topics);
  end if;
  return jsonb_build_object('ok', true, 'notify', 'sent', 'bell_topics', v_topics, 'send', v_res);
end;
$function$;

create or replace function public.asn_chat_history(p_user uuid, p_node text, p_partner_node text, p_partner_agent text, p_limit integer default 100, p_partner_id text default null::text, p_before timestamptz default null)
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
  v_web boolean := coalesce((select n.kind = 'web' from relay.nodes n where n.id = p_node), false);
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
        'id', g.own_id, 'fanout_id', g.fanout_id, 'ids', g.ids, 'dir', g.dir, 'body', g.body, 'reply_to', g.reply_to,
        'created_at', g.at, 'delivered_at', g.delivered_at, 'acked_at', g.acked_at,
        'from_node', g.from_node,
        'kind', g.kind,
        'from_owner', coalesce((select n.owner_user is not null and n.owner_user = (select t.owner_user from relay.tenants t where t.id = v_tenant) from relay.nodes n where n.id = g.from_node), false),
        'from_node_name', (select nd.name from relay.nodes nd where nd.id = g.from_node and nd.tenant_id = v_tenant)) as j
    from (
      select coalesce(m.fanout_id, m.id) as gid,
             m.fanout_id as fanout_id,
             -- 同一個 fanout_id 只留一列：呼叫端自己那份優先，沒有就取最早的
             (array_agg(m.id order by coalesce(m.to_node = p_node, false) desc, m.created_at, m.id))[1] as own_id,
             array_agg(m.id order by m.created_at, m.id) as ids,
             case when bool_or(m.from_agent = v_alias) then 'me' else 'them' end as dir,
             min(m.created_at) as at,
             (array_agg(m.body order by m.created_at, m.id))[1] as body,
             (array_agg(m.reply_to order by m.created_at, m.id))[1] as reply_to,
             min(m.delivered_at) as delivered_at,
             min(m.acked_at) as acked_at,
             (array_agg(m.from_node order by m.created_at, m.id))[1] as from_node,
             (array_agg(m.kind order by m.created_at, m.id))[1] as kind
      from relay.messages m
      where m.tenant_id = v_tenant
        and m.person_user = p_user
        and m.created_at > now() - interval '90 days'
        and (p_before is null or m.created_at < p_before)
        and (not v_web or m.kind is null or not relay.web_denied_notice(m.kind))
        and (
          (m.from_agent = v_alias and m.to_node = p_partner_node and coalesce(m.to_agent, '') = coalesce(p_partner_agent, ''))
          or (m.from_agent is distinct from v_alias and m.from_node = p_partner_node and coalesce(m.from_agent, '') = coalesce(p_partner_agent, ''))
          or (v_pid is not null and m.from_agent = v_alias and m.to_partner_id = v_pid)
          or (v_pid is not null and m.from_agent is distinct from v_alias and m.from_partner_id = v_pid)
        )
      group by coalesce(m.fanout_id, m.id), m.fanout_id
      order by min(m.created_at) desc, coalesce(m.fanout_id, m.id)
      limit v_limit
    ) g
  ) x;
  return jsonb_build_object('messages', v_out);
end;
$function$;

create or replace function public.asn_relay_inbox_watch(p_send boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  r record;
  a record;
  v_state relay.inbox_watch%rowtype;
  v_level text;
  v_stuck boolean;
  v_alert boolean;
  v_ok boolean;
  v_name text;
  v_body text;
  v_kind text;
  v_res jsonb;
  v_who text;
  v_mins int;
  v_from timestamptz;
  v_nodes int := 0;
  v_stuck_n int := 0;
  v_alert_n int := 0;
  v_sent int := 0;
begin
  delete from relay.inbox_watch_log where at < now() - interval '30 days';
  for r in
    select n.id, n.name, n.machine, n.owner_user
      from relay.nodes n
     where n.status = 'active'
       and n.last_seen_at > now() - interval '3 minutes'
       and coalesce(n.kind, '') not in ('phone', 'web')
       and coalesce(n.platform, '') not in ('android', 'ios')
       and (n.inbox_hold_until is null or n.inbox_hold_until <= now())
  loop
    v_nodes := v_nodes + 1;
    begin
      -- 依收件代理分組；last_ack＝這台的這個代理 7 天內最後一次確認信的時間（空＝不存在的代理）
      select coalesce(sum(s.cnt) filter (where s.last_ack is not null), 0)::int as cnt,
             min(s.oldest) filter (where s.last_ack is not null) as oldest,
             count(*) filter (where s.last_ack is not null and s.oldest <= now() - interval '15 minutes')::int as agents15,
             coalesce(sum(s.cnt) filter (where s.last_ack is not null and s.oldest <= now() - interval '15 minutes'), 0)::int as cnt15,
             coalesce(bool_or(s.last_ack is not null and s.oldest <= now() - interval '60 minutes' and s.last_ack <= now() - interval '60 minutes'), false) as one60,
             count(*) filter (where s.last_ack is null)::int as orphans
        into a
        from (
          select u.to_agent, u.cnt, u.oldest,
                 (select max(m.acked_at) from relay.messages m
                   where m.to_node = r.id and m.acked_at > now() - interval '7 days' and m.to_agent is not distinct from u.to_agent) as last_ack
            from (select to_agent, count(*) as cnt, min(created_at) as oldest
                    from relay.messages where to_node = r.id and acked_at is null group by to_agent) u
        ) s;

      v_level := case when a.cnt = 0 then '0' when a.cnt <= 10 then '1-10' when a.cnt <= 50 then '10-50' else '50+' end;
      v_stuck := a.agents15 > 0;
      v_alert := a.agents15 >= 2 or a.one60;
      v_ok := a.cnt = 0 or a.oldest > now() - interval '5 minutes';
      select * into v_state from relay.inbox_watch where node = r.id for update;
      if not found then
        insert into relay.inbox_watch (node) values (r.id);
        select * into v_state from relay.inbox_watch where node = r.id;
      end if;
      -- 設備名先用 name（使用者取的名字），空白才用 machine（設備種類）
      v_name := coalesce(nullif(btrim(left(regexp_replace(coalesce(nullif(btrim(r.name), ''), r.machine, ''), '[[:cntrl:]]', ' ', 'g'), 40)), ''), '未命名設備');
      v_body := null;
      v_kind := null;

      -- 寄到不存在代理的信：只記錄。由 0 變成大於 0 時記一筆
      if a.orphans > 0 and v_state.orphan_count = 0 then
        insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since, would_notify, agents)
          values (r.id, v_state.state, v_state.state, 'orphan', a.orphans, null, v_state.stuck_since, false, a.orphans);
      end if;

      -- 離線回來：stuck 的節點離線期間沒被掃到（updated_at 沒更新）。回來要重新起算，不能拿昨天的時間當持續卡著
      if v_state.state = 'stuck' and v_state.updated_at < now() - interval '10 minutes' then
        update relay.inbox_watch set stuck_since = now(), alert_since = case when alert_since is null then null else now() end where node = r.id;
        v_state.stuck_since := now();
        if v_state.alert_since is not null then v_state.alert_since := now(); end if;
        insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since, would_notify, agents)
          values (r.id, 'stuck', 'stuck', 'reset_after_offline', a.cnt, a.oldest, now(), false, a.agents15);
      end if;

      if v_stuck and v_state.state = 'ok' then
        -- 第一次判成卡住只標記，不寄：要達到通知條件、而且持續 10 分鐘才寄
        update relay.inbox_watch set state = 'stuck', stuck_since = now(), episode_oldest_at = a.oldest,
            alert_since = case when v_alert then now() end, shadow_noticed_at = null,
            level = v_level, last_count = a.cnt, last_oldest_at = a.oldest, stuck_agents = a.agents15, orphan_count = a.orphans, updated_at = now()
          where node = r.id;
        insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since, would_notify, agents)
          values (r.id, 'ok', 'stuck', 'marked', a.cnt, a.oldest, now(), v_alert, a.agents15);
      elsif v_stuck then
        update relay.inbox_watch set level = v_level, last_count = a.cnt, last_oldest_at = a.oldest, stuck_agents = a.agents15, orphan_count = a.orphans, updated_at = now()
          where node = r.id;
        if v_alert and v_state.alert_since is null then
          -- 標成卡住之後才達到通知條件（例如單一代理卡過 60 分鐘、或第二個代理也卡了）：從現在起算 10 分鐘
          update relay.inbox_watch set alert_since = now() where node = r.id;
          v_state.alert_since := now();
          insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since, would_notify, agents)
            values (r.id, 'stuck', 'stuck', 'alert', a.cnt, a.oldest, v_state.stuck_since, true, a.agents15);
        elsif not v_alert and v_state.alert_since is not null and v_state.notified_at is null then
          -- 還沒寄過就退回「只是單一代理慢」：取消起算，之後再達到條件重新算 10 分鐘
          update relay.inbox_watch set alert_since = null where node = r.id;
          v_state.alert_since := null;
        end if;
        if v_alert then
          -- 卡住的代理名（依最舊的信排序，最多列 2 個）
          select string_agg(x.nm, '、' order by x.oldest) into v_who
            from (
              select coalesce(nullif(btrim(left(regexp_replace(coalesce(u.to_agent, ''), '[[:cntrl:]]', ' ', 'g'), 20)), ''), '這台設備') as nm, u.oldest
                from (select to_agent, min(created_at) as oldest
                        from relay.messages where to_node = r.id and acked_at is null group by to_agent) u
               where u.oldest <= now() - interval '15 minutes'
                 and exists (select 1 from relay.messages m
                              where m.to_node = r.id and m.acked_at > now() - interval '7 days' and m.to_agent is not distinct from u.to_agent)
               order by u.oldest
               limit 2
            ) x;
          v_who := v_who || case when a.agents15 > 2 then ' 等 ' || a.agents15 || ' 個夥伴的 ' else ' 的 ' end;
          v_mins := (extract(epoch from now() - a.oldest) / 60)::int;
          if v_state.notified_at is null and v_state.alert_since <= now() - interval '10 minutes' then
            v_kind := 'stuck';
            v_body := v_name || '：收信可能卡住了' || E'\n' || '還在線，但寄給 ' || v_who || a.cnt15 || ' 封信都沒有送到，最舊的已經等了 ' || v_mins || ' 分鐘。可能要重開 ASN。';
          elsif v_state.notified_at is not null and v_state.notified_at <= now() - interval '24 hours' then
            v_kind := 'remind';
            v_body := v_name || '：收信還是卡著' || E'\n' || '寄給 ' || v_who || a.cnt15 || ' 封信沒有送到，最舊的已經等了 ' || v_mins || ' 分鐘。';
          end if;
        end if;
      elsif v_ok and v_state.state = 'stuck' then
        update relay.inbox_watch set level = v_level, last_count = a.cnt, last_oldest_at = a.oldest, stuck_agents = 0, orphan_count = a.orphans, updated_at = now()
          where node = r.id;
        if v_state.notified_at is null then
          -- 從沒寄過「卡住」：直接標回 ok，不寄「恢復」；would_notify 記影子跑時會不會寄過（＝開寄信時會不會寄恢復）
          update relay.inbox_watch set state = 'ok', stuck_since = null, alert_since = null, episode_oldest_at = null, shadow_noticed_at = null, recovered_at = now()
            where node = r.id;
          insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since, would_notify, agents)
            values (r.id, 'stuck', 'ok', 'recovered_silent', a.cnt, a.oldest, v_state.stuck_since, v_state.shadow_noticed_at is not null, 0);
        else
          -- 寄過「卡住」：寄成功才標回 ok；寄失敗或被限流就保持 stuck，下一輪還符合恢復條件時再試
          v_from := coalesce(v_state.episode_oldest_at, v_state.stuck_since);
          v_kind := 'recover';
          v_body := v_name || '：收信恢復了' || E'\n' || '卡了約 ' || (extract(epoch from now() - v_from) / 60)::int || ' 分鐘，現在都送到了。';
        end if;
      else
        -- 介於兩個門檻之間（5～15 分鐘），或本來就正常：保持原狀，只更新數字
        update relay.inbox_watch set level = v_level, last_count = a.cnt, last_oldest_at = a.oldest, stuck_agents = a.agents15, orphan_count = a.orphans, updated_at = now()
          where node = r.id;
      end if;
      if v_stuck then v_stuck_n := v_stuck_n + 1; end if;
      if v_stuck and v_alert then v_alert_n := v_alert_n + 1; end if;

      if v_body is not null and not coalesce(p_send, false) then
        -- 影子跑：不寄信、不記 notified_at；「這一輪會寄卡住」每段卡住只記一筆
        if v_kind = 'stuck' and v_state.shadow_noticed_at is null then
          update relay.inbox_watch set shadow_noticed_at = now() where node = r.id;
          insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since, would_notify, agents)
            values (r.id, 'stuck', 'stuck', 'notify', a.cnt15, a.oldest, v_state.stuck_since, true, a.agents15);
        end if;
      elsif v_body is not null then
        if r.owner_user is null or not public.asn_user_owns_node(r.owner_user, r.id) then
          raise warning 'inbox_watch: node % has no resolvable owner, skipped', r.id;
        else
          -- 寄信放在自己的區塊：寄不出去只是這一輪沒通知，前面更新好的狀態不會一起回復
          begin
            -- 限流（同一節點每小時 3 封，被限流這一輪就不寄）由 asn_relay_send_notice 依「節點＋種類」計算
            v_res := public.asn_relay_send_notice(r.id, 'inbox_watch', v_body, 3, interval '1 hour');
            -- 寄失敗是回傳 {"error": ...} 或 notify = 'failed'，不是丟例外：要看回傳值，寄失敗不能當成寄成功
            if v_res is null or v_res ? 'error' or v_res ->> 'notify' = 'failed' then
              raise warning 'inbox_watch: send for node % refused: %', r.id, coalesce(v_res ->> 'error', v_res ->> 'notify');
            elsif v_res ->> 'notify' = 'sent' then
              v_sent := v_sent + 1;
              if v_kind = 'recover' then
                update relay.inbox_watch set state = 'ok', stuck_since = null, alert_since = null, episode_oldest_at = null, shadow_noticed_at = null,
                    notified_at = null, recovered_at = now(), updated_at = now()
                  where node = r.id;
                insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since, would_notify, agents)
                  values (r.id, 'stuck', 'ok', 'recovered', a.cnt, a.oldest, v_state.stuck_since, true, 0);
              else
                update relay.inbox_watch set notified_at = now() where node = r.id;
                if v_kind = 'stuck' then
                  insert into relay.inbox_watch_log (node, from_state, to_state, note, cnt, oldest_at, stuck_since, would_notify, agents)
                    values (r.id, 'stuck', 'stuck', 'notify', a.cnt15, a.oldest, v_state.stuck_since, true, a.agents15);
                end if;
              end if;
            end if;
          exception when others then
            raise warning 'inbox_watch: send for node % failed: %', r.id, sqlerrm;
          end;
        end if;
      end if;
    exception when others then
      raise warning 'inbox_watch: node % failed: %', r.id, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('nodes', v_nodes, 'stuck', v_stuck_n, 'alert', v_alert_n, 'sent', v_sent, 'send_enabled', coalesce(p_send, false));
end;
$function$;

create or replace function public.asn_setup_request(p_user uuid, p_node text, p_kind text default 'claude', p_payload text default null, p_sig text default null, p_p_node text default null, p_mode text default 'install', p_requester_phone text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_r relay.setup_requests%rowtype;
  v_j jsonb;
  v_rid text;
  v_exp numeric;
  v_device boolean := p_kind in ('codex', 'grok');
  v_phone text;
begin
  if p_kind is null or p_kind not in ('claude', 'codex', 'agy', 'grok') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 模式只有 install（安裝並登入，舊行為）與 relogin（只重新登入，不安裝）；重新登入只對 claude。舊版手機不帶＝install
  if p_mode is null or p_mode not in ('install', 'relogin') or (p_mode = 'relogin' and p_kind <> 'claude') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 不是自己的節點、或節點不存在：一律回 not_found
  if p_user is null or not exists (select 1 from relay.nodes where id = p_node and status = 'active' and owner_user = p_user) then
    return jsonb_build_object('error', 'not_found');
  end if;
  -- 手機（安卓／iOS）不能被安裝：沒有電腦那一套（asn真 清單第 2 點）。平台是空的（舊版或機器橋沒回報）照舊當電腦
  if exists (select 1 from relay.nodes where id = p_node and (platform in ('android', 'ios') or coalesce(kind, '') = 'web')) then
    return jsonb_build_object('error', 'unsupported_platform');
  end if;
  -- 裝置碼型：要有請求本文、手機的設備簽章、發起的手機（本人的、有設備公鑰）。後台只檢查格式與欄位一致
  if v_device then
    if p_payload is null or p_sig is null or p_p_node is null
       or char_length(p_payload) > 1024 or p_sig !~ '^[A-Za-z0-9_-]{86}$' or p_p_node !~ '^[A-Za-z0-9_-]{1,32}$' then
      return jsonb_build_object('error', 'bad_request');
    end if;
    if not exists (select 1 from relay.nodes where id = p_p_node and status = 'active' and owner_user = p_user)
       or not exists (select 1 from relay.device_keys where node = p_p_node) then
      return jsonb_build_object('error', 'bad_request');
    end if;
    begin
      v_j := p_payload::jsonb;
    exception when others then
      return jsonb_build_object('error', 'bad_request');
    end;
    v_rid := v_j ->> 'rid';
    if jsonb_typeof(v_j) is distinct from 'object'
       or v_j ->> 'v' is distinct from 'asn-device-login-req-v1'
       or v_j ->> 't_node' is distinct from p_node
       or v_j ->> 'p_node' is distinct from p_p_node
       or v_j ->> 'vendor' is distinct from p_kind
       or coalesce(v_rid, '') !~ '^[A-Za-z0-9_-]{22}$'
       or coalesce(v_j ->> 'p_eph_pub', '') !~ '^[A-Za-z0-9_-]{43}$'
       or jsonb_typeof(v_j -> 'exp') is distinct from 'number' then
      return jsonb_build_object('error', 'bad_request');
    end if;
    v_exp := (v_j ->> 'exp')::numeric;
    -- 到期時間要在未來、而且不超過現在＋15 分鐘（容許 60 秒時鐘誤差）
    if v_exp <= extract(epoch from now()) or v_exp > extract(epoch from now()) + 960 then
      return jsonb_build_object('error', 'bad_request');
    end if;
  elsif p_payload is not null or p_sig is not null or p_p_node is not null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - interval '3 minutes') then
    return jsonb_build_object('error', 'asn_offline');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - interval '3 minutes' and relay.setup_kind_version_ok(version, p_kind)) then
    return jsonb_build_object('error', 'asn_outdated');
  end if;
  -- 重新登入要夠新的 ASN（0.2.27 起）：舊版看不懂，會當成安裝；不建立請求
  if p_mode = 'relogin' and not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - interval '3 minutes' and relay.setup_relogin_version_ok(version)) then
    return jsonb_build_object('error', 'asn_outdated');
  end if;
  perform pg_advisory_xact_lock(hashtext('setup_request:' || p_user::text));
  select * into v_r from relay.setup_requests where node = p_node for update;
  if found and ((v_r.status = 'pending' and v_r.requested_at > now() - interval '10 minutes')
             or (v_r.status = 'taken' and v_r.updated_at > now() - interval '40 minutes')) then
    -- 這台已經有進行中的請求：照舊回 already（舊版手機的行為不變），多帶那筆的種類。
    -- 裝置碼型每次都用新的 rid，所以手機看到 already 就知道不是自己這次的請求
    return jsonb_build_object('ok', true, 'already', true, 'state', v_r.status, 'kind', v_r.kind, 'mode', v_r.mode);
  end if;
  if found and v_r.status = 'failed' and v_r.updated_at > now() - interval '1 minute' then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  if (select count(*) from relay.account_events where user_id = p_user and event = 'setup_requested' and at > now() - interval '1 hour') >= 6 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  -- rid 只在列存活期間不重複：只查現存的列，同一台的請求被新請求覆蓋、或列被刪除後，舊的 rid 就不再檢查
  if v_device and exists (select 1 from relay.setup_requests where rid = v_rid) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 發出請求的手機（只有 claude 才記；要是本人名下、有效的手機節點才算，否則不記）。只活在這一次請求被電腦取走期間
  v_phone := case when p_kind = 'claude' and exists (select 1 from relay.nodes where id = p_requester_phone and status = 'active' and owner_user = p_user and platform in ('android', 'ios')) then p_requester_phone end;
  insert into relay.setup_requests (node, requested_by, kind, status, detail, replaced, requested_at, updated_at,
                                    rid, req_payload, req_sig, req_p_node, t_eph_pub, cipher, t_sig, cipher_put_at, delivered_at, expires_at, mode, requester_phone)
    values (p_node, p_user, p_kind, 'pending', null, null, now(), now(),
            case when v_device then v_rid end, case when v_device then p_payload end, case when v_device then p_sig end,
            case when v_device then p_p_node end, null, null, null, null, null,
            case when v_device then to_timestamp(v_exp) end, p_mode, v_phone)
  on conflict (node) do update
    set requested_by = excluded.requested_by, kind = excluded.kind, status = 'pending', detail = null, replaced = null,
        requested_at = excluded.requested_at, updated_at = excluded.updated_at,
        rid = excluded.rid, req_payload = excluded.req_payload, req_sig = excluded.req_sig, req_p_node = excluded.req_p_node,
        t_eph_pub = null, cipher = null, t_sig = null, cipher_put_at = null, delivered_at = null, expires_at = excluded.expires_at,
        mode = excluded.mode, requester_phone = excluded.requester_phone;
  insert into relay.account_events (user_id, event, node) values (p_user, 'setup_requested', p_node);
  return jsonb_build_object('ok', true, 'already', false, 'state', 'pending');
end;
$function$;

create or replace function public.asn_relay_setup_poll(p_node text, p_version text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_r relay.setup_requests%rowtype;
  v_pub text;
begin
  -- 過期的 pending 直接清掉；taken 太久沒回報的標成失敗，讓手機看得到；過期的密文清掉
  delete from relay.setup_requests where node = p_node and status = 'pending'
    and (requested_at <= now() - interval '10 minutes' or (expires_at is not null and expires_at <= now()));
  update relay.setup_requests set status = 'failed', detail = '電腦沒有回報結果，已逾時', updated_at = now(), requester_phone = null
    where node = p_node and status = 'taken' and updated_at <= now() - interval '40 minutes';
  update relay.setup_requests set cipher = null where node = p_node and cipher is not null and expires_at <= now();
  -- 手機不交（沒有電腦那一套會把請求標成 taken 卻不做）；平台是空的照舊當電腦
  if exists (select 1 from relay.nodes where id = p_node and (platform in ('android', 'ios') or coalesce(kind, '') = 'web')) then
    return jsonb_build_object('requested', false);
  end if;
  select * into v_r from relay.setup_requests where node = p_node for update;
  if not found or v_r.status <> 'pending' then
    return jsonb_build_object('requested', false);
  end if;
  -- 版本不夠新的 ASN 看不懂這個種類，不交給它（請求留著，等夠新的視窗來取，或過期）
  if not relay.setup_kind_version_ok(p_version, v_r.kind) then
    return jsonb_build_object('requested', false);
  end if;
  -- 重新登入不交給 0.2.27 以前的 ASN（它們會當成安裝）：標成失敗，讓手機看得到原因
  if v_r.mode = 'relogin' and not relay.setup_relogin_version_ok(p_version) then
    update relay.setup_requests set status = 'failed', detail = '這台電腦的 ASN 版本太舊，不支援從手機重新登入，請先更新 ASN', updated_at = now(), requester_phone = null where node = p_node;
    return jsonb_build_object('requested', false);
  end if;
  update relay.setup_requests set status = 'taken', updated_at = now() where node = p_node;
  if v_r.kind not in ('codex', 'grok') then
    return jsonb_build_object('requested', true, 'requested_by', v_r.requested_by, 'kind', v_r.kind, 'mode', v_r.mode);
  end if;
  select sign_pub into v_pub from relay.device_keys where node = v_r.req_p_node;
  return jsonb_build_object('requested', true, 'requested_by', v_r.requested_by, 'kind', v_r.kind, 'mode', v_r.mode,
    'rid', v_r.rid, 'payload', v_r.req_payload, 'sig', v_r.req_sig, 'p_node', v_r.req_p_node, 'p_sign_pub', v_pub,
    'expires_at', floor(extract(epoch from v_r.expires_at)));
end;
$function$;

create or replace function public.asn_update_request(p_user uuid, p_node text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_r relay.asn_update_requests%rowtype;
begin
  -- 不是自己的節點、或節點不存在：一律 not_found（不透露別人帳號下有沒有這台）
  if p_user is null or not exists (select 1 from relay.nodes where id = p_node and status = 'active' and owner_user = p_user) then
    return jsonb_build_object('error', 'not_found');
  end if;
  if exists (select 1 from relay.nodes where id = p_node and coalesce(kind, '') = 'web') then
    return jsonb_build_object('error', 'unsupported_platform');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and updated_at > now() - interval '3 minutes') then
    return jsonb_build_object('error', 'asn_offline');
  end if;
  select * into v_r from relay.asn_update_requests where node = p_node for update;
  if found and v_r.status in ('pending', 'taken') and v_r.requested_at > now() - interval '30 minutes' then
    return jsonb_build_object('ok', true, 'already', true, 'state', v_r.status);
  end if;
  if found and v_r.status = 'failed' and v_r.updated_at > now() - interval '1 minute' then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.asn_update_requests (node, requested_by, status, from_version, detail, requested_at, updated_at)
    values (p_node, p_user, 'pending', null, null, now(), now())
  on conflict (node) do update
    set requested_by = excluded.requested_by, status = 'pending', from_version = null, detail = null,
        requested_at = excluded.requested_at, updated_at = excluded.updated_at;
  insert into relay.account_events (user_id, event, node) values (p_user, 'update_requested', p_node);
  return jsonb_build_object('ok', true, 'already', false, 'state', 'pending');
end;
$function$;

create or replace function public.asn_node_create(p_user uuid, p_name text, p_machine text, p_device_id text, p_key_hash text, p_bell_topic text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_t relay.tenants%rowtype;
  v_old relay.nodes%rowtype;
  v_name text := btrim(p_name);
  v_machine text := btrim(p_machine);
  v_id text;
  v_tries int := 0;
begin
  if v_name is null or char_length(v_name) not between 1 and 40 or v_name ~ '[[:cntrl:]]'
     or v_machine is null or char_length(v_machine) not between 1 and 40 or v_machine ~ '[[:cntrl:]]'
     or p_device_id is null or p_device_id !~ '^[A-Za-z0-9_-]{16,64}$'
     or p_key_hash is null or p_bell_topic is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  v_t := relay.asn_ensure_tenant(p_user, null);
  if v_t.status <> 'active' then
    return jsonb_build_object('error', 'tenant_inactive');
  end if;

  select * into v_old from relay.nodes where owner_user = p_user and device_id = p_device_id for update;
  if found then
    update relay.nodes set key_hash = p_key_hash, bell_topic = p_bell_topic, status = 'active', name = case when v_old.name_by_owner then v_old.name else v_name end, machine = v_machine, last_seen_at = now()
      where id = v_old.id;
    insert into relay.account_events (user_id, event, node, detail) values (p_user, 'node_rekeyed', v_old.id, jsonb_build_object('via', 'device_id'));
    return jsonb_build_object('id', v_old.id, 'bell_topic', p_bell_topic, 'rotated', true);
  end if;

  if (select count(*) from relay.nodes where owner_user = p_user and status = 'active' and coalesce(kind, '') <> 'web') >= 20 then
    return jsonb_build_object('error', 'too_many');
  end if;

  loop
    -- 有前綴的租戶用 t<序號>-；舊租戶（沒前綴）用 n 開頭，避開「t<數字>-」開頭的保留格式
    v_id := coalesce(v_t.id_prefix, 'n') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
    begin
      insert into relay.nodes (id, name, key_hash, bell_topic, kind, role, can_invite, machine, status, last_seen_at, tenant_id, owner_user, device_id, created_via)
        values (v_id, v_name, p_key_hash, p_bell_topic, 'other', 'member', false, v_machine, 'active', now(), v_t.id, p_user, p_device_id, 'login-device');
      exit;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries >= 5 then
        return jsonb_build_object('error', 'internal');
      end if;
    end;
  end loop;
  insert into relay.account_events (user_id, event, node) values (p_user, 'node_created', v_id);
  return jsonb_build_object('id', v_id, 'bell_topic', p_bell_topic, 'rotated', false);
end;
$function$;

create or replace function public.asn_cloud_node_create(p_user uuid, p_name text, p_key_hash text, p_bell_topic text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_t relay.tenants%rowtype;
  v_name text := btrim(p_name);
  v_id text;
  v_tries int := 0;
begin
  if p_user is null or v_name is null or char_length(v_name) not between 1 and 40 or v_name ~ '[[:cntrl:]]'
     or p_key_hash is null or p_bell_topic is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  v_t := relay.asn_ensure_tenant(p_user, null);
  if v_t.status <> 'active' then
    return jsonb_build_object('error', 'tenant_inactive');
  end if;
  if (select count(*) from relay.nodes where owner_user = p_user and status = 'active' and coalesce(kind, '') <> 'web') >= 20
     or (select count(*) from relay.nodes where owner_user = p_user and status = 'active' and created_via = 'cloud-invite') >= 10 then
    return jsonb_build_object('error', 'too_many');
  end if;
  loop
    v_id := coalesce(v_t.id_prefix, 'n') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
    begin
      insert into relay.nodes (id, name, key_hash, bell_topic, kind, role, can_invite, machine, status, last_seen_at, tenant_id, owner_user, created_via)
        values (v_id, v_name, p_key_hash, p_bell_topic, 'other', 'member', false, '雲端代理', 'active', null, v_t.id, p_user, 'cloud-invite');
      exit;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries >= 5 then
        return jsonb_build_object('error', 'internal');
      end if;
    end;
  end loop;
  insert into relay.account_events (user_id, event, node) values (p_user, 'cloud_node_created', v_id);
  return jsonb_build_object('id', v_id, 'name', v_name);
end;
$function$;

create or replace function public.asn_device_code_approve(p_user uuid, p_user_hash text, p_node_id text, p_name text, p_bell_topic text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_t relay.tenants%rowtype;
  v_code relay.device_codes%rowtype;
  v_name text := btrim(p_name);
  v_id text := nullif(btrim(p_node_id), '');
  v_tries int := 0;
begin
  if p_user is null or p_user_hash is null or p_bell_topic is null
     or v_name is null or char_length(v_name) not between 1 and 40 or v_name ~ '[[:cntrl:]]'
     or (v_id is not null and v_id !~ '^[A-Za-z0-9_-]{1,32}$') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 抗暴力猜短碼：同一帳號 15 分鐘內輸錯 5 次，先擋（連對的碼也擋）
  if (select count(*) from relay.device_code_attempts where user_id = p_user and at > now() - interval '15 minutes') >= 5 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  select * into v_code from relay.device_codes
    where user_hash = p_user_hash and status = 'pending' and expires_at > now() for update;
  if not found then
    insert into relay.device_code_attempts (user_id) values (p_user);
    return jsonb_build_object('error', 'invalid_code');
  end if;
  v_t := relay.asn_ensure_tenant(p_user, null);
  if v_t.status <> 'active' then
    return jsonb_build_object('error', 'tenant_inactive');
  end if;
  if (select count(*) from relay.nodes where owner_user = p_user and status = 'active' and coalesce(kind, '') <> 'web') >= 20 then
    return jsonb_build_object('error', 'too_many');
  end if;
  if v_id is not null then
    -- 代號規則同 register：租戶有前綴就必須以前綴開頭；沒前綴不能用「t<數字>-」開頭（那是其他租戶的保留格式）
    if (v_t.id_prefix is not null and left(v_id, char_length(v_t.id_prefix)) <> v_t.id_prefix)
       or (v_t.id_prefix is null and v_id ~ '^t[0-9]+-') then
      return jsonb_build_object('error', 'bad_id_prefix', 'prefix', v_t.id_prefix);
    end if;
    begin
      insert into relay.nodes (id, name, key_hash, bell_topic, kind, role, can_invite, machine, status, last_seen_at, tenant_id, owner_user, created_via)
        values (v_id, v_name, 'pending:' || gen_random_uuid()::text, p_bell_topic, 'other', 'member', false, v_name, 'active', null, v_t.id, p_user, 'device-code');
    exception when unique_violation then
      return jsonb_build_object('error', 'id_taken');
    end;
  else
    loop
      v_id := coalesce(v_t.id_prefix, 'n') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
      begin
        insert into relay.nodes (id, name, key_hash, bell_topic, kind, role, can_invite, machine, status, last_seen_at, tenant_id, owner_user, created_via)
          values (v_id, v_name, 'pending:' || gen_random_uuid()::text, p_bell_topic, 'other', 'member', false, v_name, 'active', null, v_t.id, p_user, 'device-code');
        exit;
      exception when unique_violation then
        v_tries := v_tries + 1;
        if v_tries >= 5 then
          return jsonb_build_object('error', 'internal');
        end if;
      end;
    end loop;
  end if;
  update relay.device_codes set status = 'approved', approved_user = p_user, node_id = v_id, bell_topic = p_bell_topic where id = v_code.id;
  insert into relay.account_events (user_id, event, node) values (p_user, 'device_code_approved', v_id);
  return jsonb_build_object('id', v_id, 'name', v_name);
end;
$function$;

create or replace function public.asn_relay_perm_req_create(p_node text, p_window_name text, p_prompt_text text, p_complete boolean, p_options jsonb, p_hash text,
  p_options_full jsonb, p_risk jsonb, p_full_len integer)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_t uuid;
  v_owner uuid;
  v_topics jsonb;
  v_id uuid;
  v_exp timestamptz;
  v_opts jsonb := '[]'::jsonb;
  v_full jsonb := null;
  v_risk jsonb := null;
  v_codes jsonb := '[]'::jsonb;
  v_uncertain boolean := false;
  v_seen int[] := '{}';
  v_o jsonb;
  v_c jsonb;
  v_kind text;
  c_known constant text[] := array['delete_recursive','git_destructive','disk_system','remote_exec','secret_path','privilege','db_destructive','outside_cwd'];
begin
  -- relay 舊格式（其他框、舊電腦）會把 null 傳成 JSON 的 null：當成沒帶，不能回 bad_request（asn真 審查必修 3）
  if jsonb_typeof(p_options_full) = 'null' then
    p_options_full := null;
  end if;
  if jsonb_typeof(p_risk) = 'null' then
    p_risk := null;
  end if;
  select tenant_id, owner_user into v_t, v_owner from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_window_name is null or char_length(p_window_name) not between 1 and 64 or p_window_name ~ '[[:cntrl:]]'
     or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
     or p_prompt_text is null or char_length(btrim(p_prompt_text)) = 0 or char_length(p_prompt_text) > 16000
     or p_options is null or jsonb_typeof(p_options) <> 'array' or jsonb_array_length(p_options) > 9
     or (p_full_len is not null and p_full_len not between 0 and 10000000) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  for v_o in select * from jsonb_array_elements(p_options) loop
    if jsonb_typeof(v_o) is distinct from 'object' or jsonb_typeof(v_o->'n') is distinct from 'number' or (v_o->>'n') !~ '^[1-9]$'
       or jsonb_typeof(v_o->'label') is distinct from 'string' or char_length(btrim(v_o->>'label')) = 0 then
      return jsonb_build_object('error', 'bad_request');
    end if;
    v_opts := v_opts || jsonb_build_array(jsonb_build_object('n', (v_o->>'n')::int, 'label', left(regexp_replace(v_o->>'label', '[[:cntrl:]]', ' ', 'g'), 200)));
  end loop;
  if p_options_full is not null then
    if jsonb_typeof(p_options_full) <> 'array' or jsonb_array_length(p_options_full) = 0 or jsonb_array_length(p_options_full) > 9 then
      return jsonb_build_object('error', 'bad_request');
    end if;
    v_full := '[]'::jsonb;
    for v_o in select * from jsonb_array_elements(p_options_full) loop
      if jsonb_typeof(v_o) is distinct from 'object' or jsonb_typeof(v_o->'n') is distinct from 'number' or (v_o->>'n') !~ '^[1-9]$'
         or jsonb_typeof(v_o->'label') is distinct from 'string' or char_length(btrim(v_o->>'label')) = 0
         or (v_o->>'n')::int = any (v_seen) then
        return jsonb_build_object('error', 'bad_request');
      end if;
      v_seen := v_seen || (v_o->>'n')::int;
      -- 不認得的種類當「不再詢問」（手機要按住）：失敗時往安全那邊倒
      v_kind := case when v_o->>'kind' in ('allow_once', 'allow_always', 'deny', 'other') then v_o->>'kind' else 'allow_always' end;
      v_full := v_full || jsonb_build_array(jsonb_build_object('n', (v_o->>'n')::int, 'label', left(regexp_replace(v_o->>'label', '[[:cntrl:]]', ' ', 'g'), 200), 'kind', v_kind));
    end loop;
    -- 舊手機用的選項，編號要是完整選項的子集（兩份都是畫面上的數字鍵）
    if exists (select 1 from jsonb_array_elements(v_opts) o where not ((o->>'n')::int = any (v_seen))) then
      return jsonb_build_object('error', 'bad_request');
    end if;
    -- 危險代碼：白名單以外的丟掉並標 uncertain；格式不對也當看不出全貌（照常收下，手機多一層小心）
    if p_risk is not null and jsonb_typeof(p_risk) = 'object' then
      v_uncertain := coalesce(jsonb_typeof(p_risk->'uncertain') = 'boolean' and (p_risk->>'uncertain')::boolean, false);
      if jsonb_typeof(p_risk->'codes') = 'array' then
        for v_c in select * from jsonb_array_elements(p_risk->'codes') loop
          if jsonb_typeof(v_c) = 'string' and (v_c #>> '{}') = any (c_known) then
            if not v_codes @> jsonb_build_array(v_c #>> '{}') and jsonb_array_length(v_codes) < 8 then
              v_codes := v_codes || jsonb_build_array(v_c #>> '{}');
            end if;
          else
            v_uncertain := true;
          end if;
        end loop;
      elsif p_risk ? 'codes' then
        v_uncertain := true;
      end if;
    else
      v_uncertain := true;
    end if;
    v_risk := jsonb_build_object('codes', v_codes, 'uncertain', v_uncertain);
  end if;
  perform public.asn_relay_perm_req_expire();
  if exists (select 1 from relay.perm_requests where node = p_node and window_name = p_window_name and status in ('pending', 'decided', 'taken')) then
    return jsonb_build_object('error', 'busy');
  end if;
  if (select count(*) from relay.perm_requests where node = p_node and created_at > now() - interval '1 hour') >= 60 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.perm_requests (tenant_id, node, window_name, prompt_text, complete, options, body_hash, options_full, risk, full_len)
    values (v_t, p_node, p_window_name, p_prompt_text, coalesce(p_complete, false), v_opts, p_hash, v_full, v_risk, case when v_full is null then null else p_full_len end)
    returning id, expires_at into v_id, v_exp;
  -- 敲本人其他設備的門鈴（手機開著就馬上跳；門鈴沒有內容）
  select coalesce(jsonb_agg(n.bell_topic), '[]'::jsonb) into v_topics
    from relay.nodes n where n.owner_user = v_owner and n.status = 'active' and n.id <> p_node and n.bell_topic is not null and coalesce(n.kind, '') <> 'web';
  return jsonb_build_object('id', v_id, 'expires_at', v_exp, 'bell_topics', v_topics);
end;
$function$;

create or replace function public.asn_relay_secret_request(p_node text, p_pub text, p_program text, p_purpose text, p_ttl_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_owner uuid;
  v_t uuid;
  v_id uuid;
  v_exp timestamptz;
  v_topics jsonb;
begin
  perform public.asn_relay_secret_purge();
  if p_pub is null or p_pub !~ '^[A-Za-z0-9_-]{43}$'
     or p_program is null or char_length(p_program) not between 1 and 80
     or p_purpose is null or char_length(p_purpose) not between 1 and 200
     or p_ttl_seconds is null or p_ttl_seconds not between 30 and 600 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 請求端這台設備一定要有明確的主人（節點與租戶都是同一個人的），否則沒有人能替它確認
  select n.owner_user, n.tenant_id into v_owner, v_t from relay.nodes n
    where n.id = p_node and n.status = 'active' and public.asn_user_owns_node(n.owner_user, p_node);
  if v_owner is null then
    return jsonb_build_object('error', 'not_owned');
  end if;
  if exists (select 1 from relay.secret_requests where pub = p_pub) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if (select count(*) from relay.secret_requests where requester_node = p_node and status = 'pending' and expires_at > now()) >= 3 then
    return jsonb_build_object('error', 'too_many');
  end if;
  if (select count(*) from relay.secret_requests where requester_node = p_node and created_at > now() - interval '1 hour') >= 20 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  v_exp := now() + make_interval(secs => p_ttl_seconds);
  insert into relay.secret_requests (tenant_id, owner_user, requester_node, program, purpose, pub, expires_at)
    values (v_t, v_owner, p_node, p_program, p_purpose, p_pub, v_exp)
    returning id into v_id;
  select coalesce(jsonb_agg(n.bell_topic), '[]'::jsonb) into v_topics from (
    select bell_topic from relay.nodes
      where owner_user = v_owner and status = 'active' and tenant_id is not distinct from v_t and id <> p_node and bell_topic is not null and coalesce(kind, '') <> 'web'
      limit 20) n;
  return jsonb_build_object('id', v_id, 'expires_at', v_exp, 'seconds_left', p_ttl_seconds, 'bell_topics', v_topics);
end;
$function$;

create or replace function relay.room_bells(p_room text)
 returns text[] language sql stable security definer set search_path to ''
as $function$
  select coalesce(array_agg(distinct n.bell_topic), array[]::text[])
  from relay.room_members rm
  join relay.nodes n on n.status = 'active' and coalesce(n.kind, '') <> 'web' and (
       (rm.member not like '~%' and n.id = split_part(rm.member, '~', 1))
    or (rm.member like '~u:%' and n.owner_user::text = substr(rm.member, 4)))
  where rm.room_id = p_room and rm.left_at is null;
$function$;

create or replace function relay.asn_account_nodes(p_user uuid)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id, 'name', n.name, 'machine', n.machine, 'kind', n.kind,
    'last_seen_at', n.last_seen_at, 'created_via', n.created_via) order by n.created_at), '[]'::jsonb)
  from relay.nodes n where n.owner_user = p_user and n.status = 'active' and coalesce(n.kind, '') <> 'web';
$function$;

create or replace function public.asn_update_status(p_user uuid)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id,
    'update', case when r.node is null or r.requested_at <= now() - interval '30 minutes' then null
                   else jsonb_build_object('state', r.status, 'detail', r.detail, 'at', r.requested_at) end
  ) order by n.id), '[]'::jsonb)
  from relay.nodes n left join relay.asn_update_requests r on r.node = n.id
  where n.owner_user = p_user and n.status = 'active' and coalesce(n.kind, '') <> 'web';
$function$;

create or replace function public.asn_setup_status(p_user uuid)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id,
    'setup', case
      when r.node is null then null
      when r.status = 'pending' and r.requested_at <= now() - interval '10 minutes' then null
      when r.status = 'taken' and r.updated_at <= now() - interval '40 minutes' then jsonb_build_object('state', 'failed', 'detail', '電腦沒有回報結果，已逾時', 'replaced', null, 'at', r.updated_at)
      else jsonb_build_object('state', r.status, 'detail', r.detail, 'replaced', r.replaced, 'at', r.updated_at)
    end
  ) order by n.id), '[]'::jsonb)
  from relay.nodes n left join relay.setup_requests r on r.node = n.id
  where n.owner_user = p_user and n.status = 'active' and coalesce(n.kind, '') <> 'web';
$function$;

drop function if exists public.asn_relay_list(uuid);

create or replace function public.asn_relay_list(p_tenant uuid, p_include_web boolean default false)
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
        'kind', r.kind, 'receivable', r.receivable, 'model', r.model, 'hidden', r.hidden, 'elevated', r.elevated,
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
        'kind', r.kind, 'receivable', r.receivable, 'model', r.model, 'hidden', r.hidden, 'elevated', r.elevated,
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
  from relay.nodes n where n.status = 'active' and n.tenant_id is not distinct from p_tenant
    and (coalesce(p_include_web, false) or coalesce(n.kind, '') <> 'web');
$function$;
revoke all on function public.asn_relay_list(uuid, boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_list(uuid, boolean) to service_role;


-- ===== 清理：登出紀錄保留 90 天供稽核，之後刪除 =====
create or replace function public.asn_relay_web_sessions_purge()
 returns integer language plpgsql security definer set search_path to ''
as $function$
declare v_n integer;
begin
  delete from relay.web_sessions where signed_out_at is not null and signed_out_at < now() - interval '90 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;
revoke all on function public.asn_relay_web_sessions_purge() from public, anon, authenticated;
grant execute on function public.asn_relay_web_sessions_purge() to service_role;

create extension if not exists pg_cron;
select cron.unschedule('asn-web-sessions-purge') where exists (select 1 from cron.job where jobname = 'asn-web-sessions-purge');
select cron.schedule('asn-web-sessions-purge', '47 3 * * *', $$ select public.asn_relay_web_sessions_purge(); $$);

commit;
