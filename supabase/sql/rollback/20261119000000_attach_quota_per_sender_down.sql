-- 20261119000000_attach_quota_per_sender.sql 的回復檔（不是 migration，不會被部署；要用時人工執行）。
-- 把 asn_relay_attach_init 還原成 20261020000500_attachments.sql 的定義（11 個參數）。
-- 回復後 Edge 若帶新參數會收到「找不到函式」，Edge 會去掉新參數重試，附件照常。
-- sender_kind 欄位與索引留著無害；要連欄位一起拿掉，再執行最後三行（先取消註解）。
begin;

drop function if exists public.asn_relay_attach_init(text, text, text, text, integer, integer, integer, text, text, bigint, integer, uuid, bigint, integer);

create or replace function public.asn_relay_attach_init(
  p_node text, p_kind text, p_mime text, p_name text, p_bytes integer, p_width integer, p_height integer,
  p_thumb text, p_sha256 text, p_quota_bytes bigint, p_quota_count integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_tenant uuid;
  v_id uuid := gen_random_uuid();
  v_used bigint;
  v_count integer;
  v_recent integer;
  v_path text;
  v_expires timestamptz;
begin
  select tenant_id into v_tenant from relay.nodes where id = p_node and status = 'active';
  if v_tenant is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select count(*) into v_recent from relay.attachments
    where owner_node = p_node and created_at > now() - interval '1 minute';
  if v_recent >= 30 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  select coalesce(sum(bytes), 0), count(*) into v_used, v_count from relay.attachments
    where owner_node = p_node and removed_at is null and status in ('pending', 'ready') and expires_at > now();
  if v_used + p_bytes > p_quota_bytes or v_count + 1 > p_quota_count then
    return jsonb_build_object('error', 'quota_exceeded', 'used_bytes', v_used, 'used_count', v_count);
  end if;
  v_path := v_tenant::text || '/' || p_node || '/' || v_id::text || case p_mime when 'image/webp' then '.webp' else '.bin' end;
  insert into relay.attachments (id, tenant_id, owner_node, kind, mime, name, bytes, width, height, thumb, sha256, storage_path)
    values (v_id, v_tenant, p_node, p_kind, p_mime, p_name, p_bytes, p_width, p_height, p_thumb, p_sha256, v_path)
    returning expires_at into v_expires;
  return jsonb_build_object('id', v_id, 'path', v_path, 'expires_at', v_expires);
end;
$function$;

revoke all on function public.asn_relay_attach_init(text, text, text, text, integer, integer, integer, text, text, bigint, integer) from public, anon, authenticated;
grant execute on function public.asn_relay_attach_init(text, text, text, text, integer, integer, integer, text, text, bigint, integer) to service_role;

-- drop index if exists relay.attachments_owner_kind_idx;
-- alter table relay.attachments drop constraint if exists attachments_sender_kind_check;
-- alter table relay.attachments drop column if exists sender_kind;

commit;
