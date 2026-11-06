-- 配對時一併交換 D 發起觀看用的 Hello 公鑰（#597 別台看畫面 PR 4）。
-- 設計：
--   * 長度用 length() 檢查：Postgres 的正規式重複次數上限 255，不能寫 {200,1400}。
--   * device_pairs 加 from_view_pub：D 的 Hello 公鑰（RSA，PKCS#1 DER 的 base64url）。可以是空的：D 沒有 Hello 時一樣能配，只是 D 不能發起觀看。
--   * 後台只檢查格式和長度；金鑰是不是 RSA、夠不夠長由 T 本機驗，T 的確認簽章也涵蓋它，後台換掉會對不上。
--   * 不放進 device_keys：Hello 公鑰只跟著配對走，換了就要重新配對。
--   * asn_relay_device_pair_start 多一個參數 p_from_view_pub（預設 null），舊的四個參數版本移除，避免兩個版本並存；list 多回 from_view_pub。
-- 先不用：舊版不會帶這個欄位，什麼都不會變。
-- 回復：drop 新的 asn_relay_device_pair_start(text, uuid, text, text, text)，重跑 20261107100000 的 pair_start／pair_list，drop column from_view_pub。
begin;

alter table relay.device_pairs add column if not exists from_view_pub text;
alter table relay.device_pairs drop constraint if exists device_pairs_from_view_pub_check;
alter table relay.device_pairs add constraint device_pairs_from_view_pub_check
  check (from_view_pub is null or (length(from_view_pub) between 200 and 1400 and from_view_pub ~ '^[A-Za-z0-9_-]+$'));

drop function if exists public.asn_relay_device_pair_start(text, uuid, text, text);

-- D 發起配對（本人簽章）。p_from_view_pub＝D 的 Hello 公鑰，沒有 Hello 就不帶
create or replace function public.asn_relay_device_pair_start(p_actor text, p_signed_user uuid, p_to_node text, p_from_pub text, p_from_view_pub text default null)
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
  if p_from_view_pub is not null and (length(p_from_view_pub) not between 200 and 1400 or p_from_view_pub !~ '^[A-Za-z0-9_-]+$') then
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
  insert into relay.device_pairs (from_node, to_node, from_pub, to_pub, from_view_pub) values (p_actor, p_to_node, p_from_pub, v_to_pub, p_from_view_pub)
    returning id, expires_at into v_id, v_exp;
  return jsonb_build_object('id', v_id, 'to_pub', v_to_pub, 'to_name', v_name, 'expires_at', v_exp, 'bell_topic', v_topic);
end;
$function$;

-- 列出和這台有關的配對（本人簽章）：等我確認的多回 from_view_pub
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
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'from_node', p.from_node, 'from_name', n.name, 'from_pub', p.from_pub, 'from_view_pub', p.from_view_pub, 'to_pub', p.to_pub, 'expires_at', p.expires_at) order by p.created_at), '[]'::jsonb)
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

revoke all on function public.asn_relay_device_pair_start(text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.asn_relay_device_pair_list(text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_device_pair_start(text, uuid, text, text, text) to service_role;
grant execute on function public.asn_relay_device_pair_list(text, uuid) to service_role;

commit;
