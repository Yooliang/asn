-- 裝置授權登入（給沒有畫面的主機，例如 Linux 無頭主機）：主機自己跑 `asn-bridge login` 拿到短碼，
-- 人在已登入的 ASN（電腦版／手機）輸入短碼核准，主機輪詢拿到節點金鑰。設計見 docs/design/LINUX-HEADLESS.md。
--  1. relay.device_codes：只存「短碼雜湊」與「裝置碼雜湊」（明文短碼、裝置碼、金鑰都不進資料庫）。15 分鐘到期。
--  2. relay.device_code_attempts：核准時輸錯短碼的紀錄；同一帳號 15 分鐘內錯 5 次就先擋（抗暴力猜短碼，短碼本身 8 碼、約 40 位元）。
--  3. asn_device_code_start：無需金鑰；同一網路位址（呼叫端帶雜湊）每小時最多 10 次；順便清掉到期的舊紀錄、
--     並把「核准了但沒人領就到期」的節點作廢（金鑰雜湊換成無法對上的值、狀態 left）。
--  4. asn_device_code_approve：身分由 Edge Function 驗過登入憑證後帶入 p_user。核發新節點（擁有者＝該帳號、租戶＝該帳號的租戶、
--     created_via='device-code'、角色 member、不能開邀請），代號規則同 register：英數 -_ 1～32 字、租戶有前綴就必須以前綴開頭
--     （bad_id_prefix）、沒前綴不能用「t<數字>-」開頭（bad_id_prefix，prefix 為空）、撞名 id_taken；沒指定代號就用「前綴＋8 碼亂數」。
--     節點金鑰此時還不存在：key_hash 放 'pending:<亂數>'（不可能對上任何 sha256），等主機輪詢時才換成真的金鑰雜湊。
--     每帳號最多 20 個節點（與電腦、雲端代理共用）。短碼找不到／已用過／已到期一律 invalid_code（不洩漏是哪一種）並計次。
--  5. asn_device_code_poll：用裝置碼雜湊輪詢。pending＝等；approved＝核准後第一次輪詢，把 Edge Function 當場產生的金鑰雜湊寫進節點、
--     紀錄標為 consumed 並回節點代號與門鈴頻道（金鑰本身只在 Edge Function 的這次回應裡）；之後與到期都回 expired；
--     找不到 invalid_device_code；輪詢快於間隔的一半回 slow_down。
-- 相容：全部是新增（新表、新函式、nodes.created_via 檢查多一個值），既有動作與舊用戶端不受影響。
-- 先不套用：部署由負責的 session 處理（順序：本 migration → relay Edge Function → 用戶端／asn-bridge）。
-- 回復：drop 這三個函式與兩張表；nodes_created_via_check 換回 20261022050000 的定義（先把 device-code 的節點改成 cloud-invite 或刪除）。
begin;

alter table relay.nodes drop constraint if exists nodes_created_via_check;
alter table relay.nodes add constraint nodes_created_via_check
  check (created_via is null or created_via in ('login-device', 'claim-existing', 'cloud-invite', 'device-code'));

create table if not exists relay.device_codes (
  id uuid primary key default gen_random_uuid(),
  device_hash text not null unique,
  user_hash text not null unique,
  ip_hash text not null,
  interval_s integer not null default 5,
  status text not null default 'pending' check (status in ('pending', 'approved', 'consumed', 'expired')),
  approved_user uuid,
  node_id text,
  bell_topic text,
  last_poll_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes'
);
create index if not exists device_codes_ip_idx on relay.device_codes (ip_hash, created_at);
alter table relay.device_codes enable row level security;

create table if not exists relay.device_code_attempts (
  user_id uuid not null,
  at timestamptz not null default now()
);
create index if not exists device_code_attempts_idx on relay.device_code_attempts (user_id, at);
alter table relay.device_code_attempts enable row level security;

-- 核准了卻沒人領、已到期的節點：作廢（金鑰本來就還沒存在）；紀錄標為 expired
create or replace function relay.asn_device_code_sweep()
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  update relay.nodes set status = 'left', key_hash = 'revoked:' || gen_random_uuid()::text,
         bell_topic = 'revoked-bell-' || gen_random_uuid()::text
    where created_via = 'device-code' and key_hash like 'pending:%'
      and id in (select node_id from relay.device_codes where status = 'approved' and expires_at <= now());
  update relay.device_codes set status = 'expired' where status in ('pending', 'approved') and expires_at <= now();
  delete from relay.device_codes where expires_at < now() - interval '1 day';
  delete from relay.device_code_attempts where at < now() - interval '1 day';
end;
$function$;
revoke all on function relay.asn_device_code_sweep() from public, anon, authenticated;

create or replace function public.asn_device_code_start(p_ip_hash text, p_device_hash text, p_user_hash text, p_interval integer default 5)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_exp timestamptz;
  v_int integer := least(greatest(coalesce(p_interval, 5), 2), 30);
begin
  if p_ip_hash is null or p_device_hash is null or p_user_hash is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  perform relay.asn_device_code_sweep();
  if (select count(*) from relay.device_codes where ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  begin
    insert into relay.device_codes (device_hash, user_hash, ip_hash, interval_s)
      values (p_device_hash, p_user_hash, p_ip_hash, v_int)
      returning expires_at into v_exp;
  exception when unique_violation then
    return jsonb_build_object('error', 'collision');
  end;
  return jsonb_build_object('expires_at', v_exp, 'interval', v_int);
end;
$function$;
revoke all on function public.asn_device_code_start(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.asn_device_code_start(text, text, text, integer) to service_role;

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
  if (select count(*) from relay.nodes where owner_user = p_user and status = 'active') >= 20 then
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
revoke all on function public.asn_device_code_approve(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_device_code_approve(uuid, text, text, text, text) to service_role;

create or replace function public.asn_device_code_poll(p_device_hash text, p_key_hash text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_code relay.device_codes%rowtype;
  v_slow boolean;
begin
  if p_device_hash is null then
    return jsonb_build_object('error', 'invalid_device_code');
  end if;
  select * into v_code from relay.device_codes where device_hash = p_device_hash for update;
  if not found then
    return jsonb_build_object('error', 'invalid_device_code');
  end if;
  if v_code.status in ('pending', 'approved') and v_code.expires_at <= now() then
    perform relay.asn_device_code_sweep();
    return jsonb_build_object('status', 'expired');
  end if;
  if v_code.status in ('consumed', 'expired') then
    return jsonb_build_object('status', 'expired');
  end if;
  v_slow := v_code.last_poll_at is not null and v_code.last_poll_at > now() - make_interval(secs => v_code.interval_s / 2.0);
  update relay.device_codes set last_poll_at = now() where id = v_code.id;
  if v_slow then
    return jsonb_build_object('error', 'slow_down');
  end if;
  if v_code.status = 'pending' then
    return jsonb_build_object('status', 'pending');
  end if;
  -- approved：第一次輪詢把金鑰雜湊寫進節點（只有還是 pending: 的才換），之後作廢
  if p_key_hash is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.nodes set key_hash = p_key_hash, last_seen_at = now()
    where id = v_code.node_id and created_via = 'device-code' and key_hash like 'pending:%' and status = 'active';
  if not found then
    return jsonb_build_object('status', 'expired');
  end if;
  update relay.device_codes set status = 'consumed' where id = v_code.id;
  return jsonb_build_object('status', 'approved', 'id', v_code.node_id, 'bell_topic', v_code.bell_topic);
end;
$function$;
revoke all on function public.asn_device_code_poll(text, text) from public, anon, authenticated;
grant execute on function public.asn_device_code_poll(text, text) to service_role;

commit;
