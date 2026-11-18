-- 附件額度依寄件人分開算（#1723）：每筆附件記「本人」或「AI」，AI 另可設上限，讓 AI 視窗互寄的截圖擠不掉本人寄的照片。
-- 本人以登入憑證判定，跟信件 owner_signed 是同一套規則（asn_user_owns_node）；沒憑證、憑證的人不擁有這台設備的一律算 AI。
-- 新增欄位 relay.attachments.sender_kind：空值＝套用前的舊資料，只算設備總量、不算 AI 桶（30 天內自然過期）。
-- asn_relay_attach_init 尾端加三個有預設值的參數（p_signed_user、p_ai_quota_bytes、p_ai_quota_count）：
--   舊 Edge 只傳原本 11 個參數也能呼叫，行為與以前相同；AI 上限傳空值＝不啟用。超額回 quota_exceeded，多帶 scope（device／agent）。
-- 換簽章要先拿掉舊的 11 參數版本（留著會讓具名呼叫無法選擇，見 20261021060000_owner_signed.sql）；舊名 irori_relay_attach_init 的包裝以位置參數呼叫新版，照常。
-- 部署順序：先套本 migration，再部署 Edge；Edge 找不到新版函式時會去掉新參數重試。可重跑。
-- 回復：supabase/sql/rollback/20261119000000_attach_quota_per_sender_down.sql。
begin;

alter table relay.attachments add column if not exists sender_kind text;
alter table relay.attachments drop constraint if exists attachments_sender_kind_check;
alter table relay.attachments add constraint attachments_sender_kind_check
  check (sender_kind is null or sender_kind in ('owner', 'agent'));
create index if not exists attachments_owner_kind_idx on relay.attachments (owner_node, sender_kind)
  where removed_at is null;

drop function if exists public.asn_relay_attach_init(text, text, text, text, integer, integer, integer, text, text, bigint, integer);

create or replace function public.asn_relay_attach_init(
  p_node text, p_kind text, p_mime text, p_name text, p_bytes integer, p_width integer, p_height integer,
  p_thumb text, p_sha256 text, p_quota_bytes bigint, p_quota_count integer,
  p_signed_user uuid default null, p_ai_quota_bytes bigint default null, p_ai_quota_count integer default null)
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
  v_ai_used bigint;
  v_ai_count integer;
  v_recent integer;
  v_path text;
  v_expires timestamptz;
  v_kind text;
begin
  select tenant_id into v_tenant from relay.nodes where id = p_node and status = 'active';
  if v_tenant is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  v_kind := case when p_signed_user is not null and public.asn_user_owns_node(p_signed_user, p_node)
                 then 'owner' else 'agent' end;
  select count(*) into v_recent from relay.attachments
    where owner_node = p_node and created_at > now() - interval '1 minute';
  if v_recent >= 30 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  select coalesce(sum(bytes), 0), count(*),
         coalesce(sum(bytes) filter (where sender_kind = 'agent'), 0),
         count(*) filter (where sender_kind = 'agent')
    into v_used, v_count, v_ai_used, v_ai_count
    from relay.attachments
    where owner_node = p_node and removed_at is null and status in ('pending', 'ready') and expires_at > now();
  if v_used + p_bytes > p_quota_bytes or v_count + 1 > p_quota_count then
    return jsonb_build_object('error', 'quota_exceeded', 'scope', 'device', 'used_bytes', v_used, 'used_count', v_count);
  end if;
  if v_kind = 'agent'
     and ((p_ai_quota_bytes is not null and v_ai_used + p_bytes > p_ai_quota_bytes)
       or (p_ai_quota_count is not null and v_ai_count + 1 > p_ai_quota_count)) then
    return jsonb_build_object('error', 'quota_exceeded', 'scope', 'agent', 'used_bytes', v_ai_used, 'used_count', v_ai_count);
  end if;
  v_path := v_tenant::text || '/' || p_node || '/' || v_id::text || case p_mime when 'image/webp' then '.webp' else '.bin' end;
  insert into relay.attachments (id, tenant_id, owner_node, kind, mime, name, bytes, width, height, thumb, sha256, storage_path, sender_kind)
    values (v_id, v_tenant, p_node, p_kind, p_mime, p_name, p_bytes, p_width, p_height, p_thumb, p_sha256, v_path, v_kind)
    returning expires_at into v_expires;
  return jsonb_build_object('id', v_id, 'path', v_path, 'expires_at', v_expires);
end;
$function$;

revoke all on function public.asn_relay_attach_init(text, text, text, text, integer, integer, integer, text, text, bigint, integer, uuid, bigint, integer) from public, anon, authenticated;
grant execute on function public.asn_relay_attach_init(text, text, text, text, integer, integer, integer, text, text, bigint, integer, uuid, bigint, integer) to service_role;

commit;
