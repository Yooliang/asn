-- 設備金鑰（#597 別台看畫面，0.2.8 改版）：每台一把設備金鑰（Ed25519），公鑰上傳到這裡給別台查。
-- 設計（小良哥 11-07 改版，asn真 定）：
--   * 不再手動配對。兩台第一次連線時各自記住對方的設備公鑰（TOFU，像 SSH known_hosts，記在各台本機），之後公鑰換了就拒絕。
--   * 後台只轉交公鑰，**信任只看各台本機記的**：後台被控制可以塞假公鑰，但只有「第一次」會被記住，而第一次也會通知本人（見 20261107130000）。
--   * 只有公鑰上傳用節點金鑰；誰能看誰由 term_views 的函式決定（兩台都要是同一個本人的）。
-- 先不用：舊版不會呼叫這個動作，什麼都不會變。
-- 回復：drop 函式 asn_relay_device_key_publish 與 relay.device_keys。
begin;

create table if not exists relay.device_keys (
  node text not null,
  tenant_id uuid not null,
  sign_pub text not null,
  updated_at timestamptz not null default now(),
  constraint device_keys_pkey primary key (node),
  constraint device_keys_pub_check check (sign_pub ~ '^[A-Za-z0-9_-]{43}$'),
  constraint device_keys_node_fkey foreign key (node) references relay.nodes(id) on delete cascade,
  constraint device_keys_node_same_tenant foreign key (tenant_id, node) references relay.nodes(tenant_id, id) on delete cascade
);
alter table relay.device_keys enable row level security;
revoke all on relay.device_keys from public, anon, authenticated;

-- 上傳自己的設備公鑰（節點金鑰）。重裝就是新金鑰：這裡直接蓋掉，對方本機記的舊公鑰對不上就會拒絕並通知本人
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

revoke all on function public.asn_relay_device_key_publish(text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_device_key_publish(text, text) to service_role;

commit;
