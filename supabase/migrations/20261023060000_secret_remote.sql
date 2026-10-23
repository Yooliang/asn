-- 遠端一次性密碼傳遞（#26 第二期；設計見 docs/design/SECRET-REMOTE.md）。
-- 別台電腦（或雲端代理）的程式要密碼 → 請求端產生一次性 X25519 鑰匙對，只把「公鑰」送上來 → 本人的設備（電腦 ASN 或手機）跳窗確認
-- → 本人輸入的密碼在本人設備上用該公鑰加密 → 密文經這裡送回 → 請求端取走、解密、直接交給要密碼的程式。
-- 後台從頭到尾只看得到：公鑰、用途說明、密文（看不懂）。密文只存到被取走或過期，之後立刻清成 null；請求列過期後整列刪除。
-- 回覆（pending／reply）一定要本人簽章（p_signed_user，Edge Function 驗過登入憑證才傳進來），而且簽章的人要擁有「回覆的設備」與「請求端節點」。
-- 不改任何既有資料表與函式。先不套用：部署順序為 migration → relay 函式 → 發新版 ASN（反過來也安全：舊後台對新動作回 404，ASN 靜默略過）。
begin;

create table if not exists relay.secret_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  owner_user uuid not null,
  requester_node text not null references relay.nodes(id) on delete cascade,
  program text not null check (char_length(program) between 1 and 80),
  purpose text not null check (char_length(purpose) between 1 and 200),
  -- 請求端一次性公鑰：32 位元組的 base64url（43 字、無補齊）。唯一：同一把公鑰不能再開第二個請求（重放保護）
  pub text not null check (pub ~ '^[A-Za-z0-9_-]{43}$'),
  status text not null default 'pending' check (status in ('pending', 'answered', 'delivered', 'denied')),
  -- 密文（base64url）。只有 answered 狀態才有值；被取走、拒絕、過期時一律清成 null
  cipher text check (cipher is null or (char_length(cipher) between 100 and 2048 and cipher ~ '^[A-Za-z0-9_-]+$')),
  responder_node text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  answered_at timestamptz
);
create unique index if not exists secret_requests_pub_uq on relay.secret_requests (pub);
create index if not exists secret_requests_owner_idx on relay.secret_requests (owner_user, status, expires_at);
create index if not exists secret_requests_node_idx on relay.secret_requests (requester_node, created_at);
alter table relay.secret_requests enable row level security;
revoke all on relay.secret_requests from public, anon, authenticated;

-- 過期自動清：每個動作開頭都先跑一次。密文：過期、已取走、已拒絕的立刻清成 null；請求列：過期一小時後刪除（留一小時讓請求端查得到「已過期」）
create or replace function public.asn_relay_secret_purge()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare v_n integer;
begin
  update relay.secret_requests set cipher = null
    where cipher is not null and (expires_at <= now() or status in ('delivered', 'denied'));
  delete from relay.secret_requests where expires_at <= now() - interval '1 hour';
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

-- 請求端建立請求（節點金鑰驗證後的節點 p_node）。回 { id, expires_at, bell_topics }；bell_topics 是本人其他設備的門鈴，Edge Function 一一敲響
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
      where owner_user = v_owner and status = 'active' and tenant_id is not distinct from v_t and id <> p_node and bell_topic is not null
      limit 20) n;
  return jsonb_build_object('id', v_id, 'expires_at', v_exp, 'bell_topics', v_topics);
end;
$function$;

-- 本人設備查待確認的請求（要本人簽章，且簽章的人擁有這台設備）。只回公鑰與說明，**不含密文**
create or replace function public.asn_relay_secret_pending(p_actor text, p_signed_user uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_out jsonb;
begin
  perform public.asn_relay_secret_purge();
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'node', r.requester_node, 'node_name', (select n.name from relay.nodes n where n.id = r.requester_node),
      'program', r.program, 'purpose', r.purpose, 'pub', r.pub, 'created_at', r.created_at, 'expires_at', r.expires_at)
      order by r.created_at), '[]'::jsonb)
    into v_out from relay.secret_requests r
    where r.owner_user = p_signed_user and r.status = 'pending' and r.expires_at > now()
      and public.asn_user_owns_node(p_signed_user, r.requester_node);
  return jsonb_build_object('requests', v_out);
end;
$function$;

-- 本人回覆：交出密文，或拒絕。一次性——只有 pending 且沒過期的能被回覆；第二次回覆一律 already_answered
create or replace function public.asn_relay_secret_reply(p_actor text, p_signed_user uuid, p_id uuid, p_cipher text, p_deny boolean)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_row relay.secret_requests;
  v_topic text;
begin
  perform public.asn_relay_secret_purge();
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_id is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not coalesce(p_deny, false) and (p_cipher is null or char_length(p_cipher) not between 100 and 2048 or p_cipher !~ '^[A-Za-z0-9_-]+$') then
    return jsonb_build_object('error', 'bad_cipher');
  end if;
  select * into v_row from relay.secret_requests
    where id = p_id and owner_user = p_signed_user and public.asn_user_owns_node(p_signed_user, requester_node)
    for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_row.expires_at <= now() then
    return jsonb_build_object('error', 'expired');
  end if;
  if v_row.status <> 'pending' then
    return jsonb_build_object('error', 'already_answered');
  end if;
  update relay.secret_requests
    set status = case when coalesce(p_deny, false) then 'denied' else 'answered' end,
        cipher = case when coalesce(p_deny, false) then null else p_cipher end,
        responder_node = p_actor, answered_at = now()
    where id = p_id;
  select bell_topic into v_topic from relay.nodes where id = v_row.requester_node;
  return jsonb_build_object('ok', true, 'bell_topic', v_topic);
end;
$function$;

-- 請求端取回答（節點金鑰；只能取自己這台的請求）。pending／denied／expired／delivered 只回狀態；
-- answered 且沒過期才回密文，並在同一個動作裡把密文清成 null、狀態改成 delivered——密文只會被取走一次
create or replace function public.asn_relay_secret_fetch(p_node text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_row relay.secret_requests;
  v_cipher text;
begin
  perform public.asn_relay_secret_purge();
  select * into v_row from relay.secret_requests where id = p_id and requester_node = p_node for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_row.status = 'pending' then
    return jsonb_build_object('status', case when v_row.expires_at <= now() then 'expired' else 'pending' end);
  end if;
  if v_row.status = 'denied' then
    return jsonb_build_object('status', 'denied');
  end if;
  if v_row.status = 'delivered' then
    return jsonb_build_object('status', 'delivered');
  end if;
  if v_row.expires_at <= now() or v_row.cipher is null then
    return jsonb_build_object('status', 'expired');
  end if;
  v_cipher := v_row.cipher;
  update relay.secret_requests set status = 'delivered', cipher = null where id = p_id;
  return jsonb_build_object('status', 'answered', 'cipher', v_cipher);
end;
$function$;

revoke all on function public.asn_relay_secret_purge() from public, anon, authenticated;
grant execute on function public.asn_relay_secret_purge() to service_role;
revoke all on function public.asn_relay_secret_request(text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.asn_relay_secret_request(text, text, text, text, integer) to service_role;
revoke all on function public.asn_relay_secret_pending(text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_secret_pending(text, uuid) to service_role;
revoke all on function public.asn_relay_secret_reply(text, uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_secret_reply(text, uuid, uuid, text, boolean) to service_role;
revoke all on function public.asn_relay_secret_fetch(text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_secret_fetch(text, uuid) to service_role;

commit;
