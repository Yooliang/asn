-- 設備配對（#597 別台看畫面的工作包 E）：每台一把設備金鑰，兩台要各自由本人確認才互相認得。
-- 設計：
--   * 後台只轉交公鑰，**信任只看各台本機記的**：後台被控制也變不出配對（對方會用本機記的公鑰驗簽章）。
--   * 配對請求留 7 天：本人在 D 按，回到 T 比對指紋再按確認，不必同時在場。T 確認前什麼都不生效。
--   * 全部動作都要本人簽章，而且兩台都是這個人的（asn_user_owns_node）。只有公鑰上傳用節點金鑰。
--   * 同一對設備同時只有一筆進行中；每個節點每小時最多發 20 筆。結案一天後刪除。
-- 先不用：舊版不會呼叫這幾個動作，什麼都不會變。這張還沒有任何東西會看畫面。
-- 回復：drop 這些函式與 relay.device_keys、relay.device_pairs。
begin;

create table if not exists relay.device_keys (
  node text not null,
  tenant_id uuid not null,
  sign_pub text not null,
  updated_at timestamptz not null default now(),
  constraint device_keys_pkey primary key (node),
  constraint device_keys_pub_check check (sign_pub ~ '^[A-Za-z0-9_-]{43}$'),
  constraint device_keys_node_fkey foreign key (node) references relay.nodes(id),
  constraint device_keys_node_same_tenant foreign key (tenant_id, node) references relay.nodes(tenant_id, id)
);
alter table relay.device_keys enable row level security;
revoke all on relay.device_keys from public, anon, authenticated;

create table if not exists relay.device_pairs (
  id uuid not null default gen_random_uuid(),
  from_node text not null,
  to_node text not null,
  from_pub text not null,
  to_pub text not null,
  status text not null default 'pending',
  confirm_sig text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  decided_at timestamptz,
  constraint device_pairs_pkey primary key (id),
  constraint device_pairs_distinct check (from_node <> to_node),
  constraint device_pairs_from_pub_check check (from_pub ~ '^[A-Za-z0-9_-]{43}$'),
  constraint device_pairs_to_pub_check check (to_pub ~ '^[A-Za-z0-9_-]{43}$'),
  constraint device_pairs_sig_check check (confirm_sig is null or confirm_sig ~ '^[A-Za-z0-9_-]{86}$'),
  constraint device_pairs_status_check check (status = any (array['pending','confirmed','rejected','cancelled','expired'])),
  constraint device_pairs_from_fkey foreign key (from_node) references relay.nodes(id),
  constraint device_pairs_to_fkey foreign key (to_node) references relay.nodes(id)
);
create index if not exists device_pairs_from_idx on relay.device_pairs (from_node, created_at);
create index if not exists device_pairs_to_idx on relay.device_pairs (to_node, status);
alter table relay.device_pairs enable row level security;
revoke all on relay.device_pairs from public, anon, authenticated;

create or replace function public.asn_relay_device_pair_expire()
 returns void language plpgsql security definer set search_path to ''
as $function$
begin
  update relay.device_pairs set status = 'expired', decided_at = now() where status = 'pending' and expires_at <= now();
  delete from relay.device_pairs where status <> 'pending' and decided_at < now() - interval '1 day';
end;
$function$;

-- 上傳自己的設備公鑰（節點金鑰）。重裝就是新金鑰：這裡直接蓋掉，對方本機記的舊公鑰對不上就會警告並停止
create or replace function public.asn_relay_device_key_publish(p_node text, p_sign_pub text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_t uuid;
begin
  select tenant_id into v_t from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_sign_pub is null or p_sign_pub !~ '^[A-Za-z0-9_-]{43}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  insert into relay.device_keys (node, tenant_id, sign_pub) values (p_node, v_t, p_sign_pub)
    on conflict (node) do update set sign_pub = excluded.sign_pub, updated_at = now()
    where relay.device_keys.sign_pub is distinct from excluded.sign_pub;
  return jsonb_build_object('ok', true);
end;
$function$;

-- 在 D 發起配對（本人簽章）。兩台都要是本人的；T 要已經上傳過公鑰（舊版沒有）
create or replace function public.asn_relay_device_pair_start(p_actor text, p_signed_user uuid, p_to_node text, p_from_pub text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_to_pub text;
  v_topic text;
  v_name text;
  v_id uuid;
  v_exp timestamptz;
begin
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_to_node is null or p_to_node = p_actor or p_from_pub is null or p_from_pub !~ '^[A-Za-z0-9_-]{43}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not public.asn_user_owns_node(p_signed_user, p_to_node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  perform public.asn_relay_device_pair_expire();
  select sign_pub into v_to_pub from relay.device_keys where node = p_to_node;
  if not found then
    return jsonb_build_object('error', 'no_key');
  end if;
  if exists (select 1 from relay.device_pairs where from_node = p_actor and to_node = p_to_node and status = 'pending') then
    return jsonb_build_object('error', 'busy');
  end if;
  if (select count(*) from relay.device_pairs where from_node = p_actor and created_at > now() - interval '1 hour') >= 20 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  select bell_topic, name into v_topic, v_name from relay.nodes where id = p_to_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  insert into relay.device_pairs (from_node, to_node, from_pub, to_pub) values (p_actor, p_to_node, p_from_pub, v_to_pub)
    returning id, expires_at into v_id, v_exp;
  return jsonb_build_object('id', v_id, 'to_pub', v_to_pub, 'to_name', v_name, 'expires_at', v_exp, 'bell_topic', v_topic);
end;
$function$;

-- 列出和這台有關的配對（本人簽章）：等我確認的、我發起的
create or replace function public.asn_relay_device_pair_list(p_actor text, p_signed_user uuid)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_in jsonb;
  v_out jsonb;
begin
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  perform public.asn_relay_device_pair_expire();
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'from_node', p.from_node, 'from_name', n.name, 'from_pub', p.from_pub, 'to_pub', p.to_pub, 'expires_at', p.expires_at) order by p.created_at), '[]'::jsonb)
    into v_in
    from relay.device_pairs p join relay.nodes n on n.id = p.from_node
    where p.to_node = p_actor and p.status = 'pending' and public.asn_user_owns_node(p_signed_user, p.from_node);
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'to_node', p.to_node, 'to_name', n.name, 'to_pub', p.to_pub, 'status', p.status, 'confirm_sig', p.confirm_sig, 'expires_at', p.expires_at) order by p.created_at), '[]'::jsonb)
    into v_out
    from relay.device_pairs p join relay.nodes n on n.id = p.to_node
    where p.from_node = p_actor;
  return jsonb_build_object('incoming', v_in, 'outgoing', v_out);
end;
$function$;

-- T 決定（本人簽章）。確認要帶 T 的簽章，D 用自己記下的 T 公鑰驗；只有這台自己能決定
create or replace function public.asn_relay_device_pair_decide(p_actor text, p_signed_user uuid, p_id uuid, p_decision text, p_sig text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare r relay.device_pairs%rowtype;
begin
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_id is null or p_decision is null or p_decision not in ('confirm', 'reject') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if p_decision = 'confirm' and (p_sig is null or p_sig !~ '^[A-Za-z0-9_-]{86}$') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  perform public.asn_relay_device_pair_expire();
  select * into r from relay.device_pairs where id = p_id for update;
  if not found or r.status <> 'pending' or r.to_node <> p_actor then
    return jsonb_build_object('error', 'not_found');
  end if;
  if not public.asn_user_owns_node(p_signed_user, r.from_node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_decision = 'reject' then
    update relay.device_pairs set status = 'rejected', decided_at = now() where id = r.id;
    return jsonb_build_object('ok', true, 'status', 'rejected');
  end if;
  update relay.device_pairs set status = 'confirmed', confirm_sig = p_sig, decided_at = now() where id = r.id;
  return jsonb_build_object('ok', true, 'status', 'confirmed');
end;
$function$;

-- D 撤回或收掉已看過的結果（本人簽章）。只動自己發起的
create or replace function public.asn_relay_device_pair_close(p_actor text, p_signed_user uuid, p_id uuid)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_n int;
begin
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_id is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  delete from relay.device_pairs where id = p_id and from_node = p_actor;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.asn_relay_device_pair_expire() from public, anon, authenticated;
revoke all on function public.asn_relay_device_key_publish(text, text) from public, anon, authenticated;
revoke all on function public.asn_relay_device_pair_start(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.asn_relay_device_pair_list(text, uuid) from public, anon, authenticated;
revoke all on function public.asn_relay_device_pair_decide(text, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.asn_relay_device_pair_close(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_device_key_publish(text, text) to service_role;
grant execute on function public.asn_relay_device_pair_start(text, uuid, text, text) to service_role;
grant execute on function public.asn_relay_device_pair_list(text, uuid) to service_role;
grant execute on function public.asn_relay_device_pair_decide(text, uuid, uuid, text, text) to service_role;
grant execute on function public.asn_relay_device_pair_close(text, uuid, uuid) to service_role;

commit;
