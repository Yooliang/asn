-- 附件（傳照片）：私有 bucket、附件表、授權與清理函式、30 天排程。設計見 docs/ATTACHMENTS.md。
-- 不改既有的信件表與函式：附件關聯放在 relay.attachments，Edge Function 回信件時另外查出來附上。
-- 回復做法見檔尾註解。

-- ===== bucket：私有、單檔 5 MB、只收 webp（之後開新型別時改 allowed_mime_types） =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 26214400, array['image/webp', 'application/pdf', 'text/plain', 'text/markdown', 'application/json', 'text/csv', 'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'])
on conflict (id) do update
  set public = false, file_size_limit = 26214400, allowed_mime_types = excluded.allowed_mime_types;
-- 單檔上限 25 MB（一般檔案）；照片另外限 5 MB（表的 check 與函式都擋）。型別白名單：照片只收 webp；
-- 檔案收 pdf、txt、md、json、csv、zip、docx、xlsx、pptx，可執行檔一律不在白名單內。

-- 前端角色（anon、authenticated）任何情況都碰不到這個 bucket 的物件：限制性政策與其他政策取交集，
-- 就算以後有人替別的 bucket 加了寬鬆政策也開不到這裡。只有 service role（Edge Function）能簽上傳與下載網址。
drop policy if exists attachments_no_client_access on storage.objects;
create policy attachments_no_client_access on storage.objects
  as restrictive for all to anon, authenticated
  using (bucket_id <> 'attachments')
  with check (bucket_id <> 'attachments');

-- ===== 附件表 =====
create table relay.attachments (
  id uuid not null default gen_random_uuid(),
  tenant_id uuid not null,
  owner_node text not null,
  kind text not null,
  mime text not null,
  name text not null,
  bytes integer not null,
  width integer,
  height integer,
  thumb text,
  sha256 text,
  storage_path text not null,
  status text not null default 'pending',
  message_id uuid,
  room_id text,
  room_seq bigint,
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '30 days'),
  removed_at timestamptz,
  constraint attachments_pkey primary key (id),
  constraint attachments_tenant_id_fkey foreign key (tenant_id) references relay.tenants(id),
  constraint attachments_owner_fkey foreign key (tenant_id, owner_node) references relay.nodes(tenant_id, id),
  constraint attachments_message_id_fkey foreign key (message_id) references relay.messages(id) on delete set null,
  constraint attachments_kind_check check (kind = any (array['image', 'file'])),
  constraint attachments_mime_check check (mime = any (array['image/webp', 'application/pdf', 'text/plain', 'text/markdown', 'application/json', 'text/csv', 'application/zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'])),
  constraint attachments_kind_mime_check check ((kind = 'image' and mime = 'image/webp' and bytes <= 5242880) or (kind = 'file' and mime <> 'image/webp' and thumb is null)),
  constraint attachments_name_check check (char_length(name) >= 1 and char_length(name) <= 80),
  constraint attachments_bytes_check check (bytes > 0 and bytes <= 26214400),
  constraint attachments_status_check check (status = any (array['pending','ready','expired'])),
  constraint attachments_sha256_check check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  constraint attachments_thumb_check check (thumb is null or (char_length(thumb) <= 12000 and thumb ~ '^data:image/webp;base64,[A-Za-z0-9+/]+={0,2}$')),
  constraint attachments_bind_check check (not (message_id is not null and room_id is not null))
);
create index attachments_owner_idx on relay.attachments (owner_node, created_at);
create index attachments_message_idx on relay.attachments (message_id) where message_id is not null;
create index attachments_room_idx on relay.attachments (room_id, room_seq) where room_id is not null;
create index attachments_expiry_idx on relay.attachments (expires_at) where removed_at is null;

alter table relay.attachments enable row level security;
revoke all on relay.attachments from public, anon, authenticated;

-- ===== 函式（全部 SECURITY DEFINER，只授權 service_role） =====

-- 要上傳：檢查每分鐘次數與每台設備總量，建一列 pending，回附件編號與儲存路徑
create or replace function public.irori_relay_attach_init(
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

-- 確認上傳完成：只有上傳者、只有 pending；實際大小與型別由函式向 Storage 查好後傳入，不一致就把這列作廢
create or replace function public.irori_relay_attach_commit(p_node text, p_id uuid, p_bytes integer, p_mime text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  a relay.attachments%rowtype;
begin
  select * into a from relay.attachments where id = p_id and owner_node = p_node;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  -- p_bytes 為空＝只查路徑與狀態（函式要先知道路徑才能向 Storage 查實際大小）
  if p_bytes is null then
    return jsonb_build_object('peek', true, 'path', a.storage_path, 'status', a.status);
  end if;
  if a.status = 'ready' then
    return jsonb_build_object('ok', true, 'path', a.storage_path);
  end if;
  if a.status <> 'pending' or a.expires_at <= now() then
    return jsonb_build_object('error', 'expired');
  end if;
  if p_bytes is distinct from a.bytes or p_mime is distinct from a.mime then
    update relay.attachments set status = 'expired', thumb = null where id = p_id;
    return jsonb_build_object('error', 'size_mismatch', 'path', a.storage_path);
  end if;
  update relay.attachments set status = 'ready', committed_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'path', a.storage_path);
end;
$function$;

-- 寄信前檢查：每個編號都是自己上傳的、ready、還沒綁過、沒過期
create or replace function public.irori_relay_attach_claim(p_node text, p_ids uuid[])
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select case
    when coalesce(cardinality(p_ids), 0) = 0 then jsonb_build_object('ok', true)
    when (select count(*) from relay.attachments a
            where a.id = any(p_ids) and a.owner_node = p_node and a.status = 'ready'
              and a.message_id is null and a.room_id is null and a.expires_at > now() and a.removed_at is null)
         = (select count(distinct x) from unnest(p_ids) x)
      then jsonb_build_object('ok', true)
    else jsonb_build_object('error', 'bad_attachment')
  end;
$function$;

-- 寄出後綁定到信件（一對一給 p_message_id；群組給 p_room＋p_seq）；回綁到幾個
create or replace function public.irori_relay_attach_bind(p_node text, p_ids uuid[], p_message_id uuid, p_room text, p_seq bigint)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_n integer;
begin
  update relay.attachments
    set message_id = case when p_room is null then p_message_id else null end,
        room_id = p_room,
        room_seq = case when p_room is null then null else p_seq end
    where id = any(coalesce(p_ids, array[]::uuid[])) and owner_node = p_node and status = 'ready'
      and message_id is null and room_id is null and expires_at > now();
  get diagnostics v_n = row_count;
  return jsonb_build_object('bound', v_n);
end;
$function$;

-- 回信件時附帶的附件資訊。呼叫端已確認這些信件／群組訊息本來就是這個節點有權讀的。
create or replace function public.irori_relay_attach_for(p_message_ids uuid[], p_room text, p_seqs bigint[])
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
      'message_id', a.message_id, 'room_seq', a.room_seq, 'id', a.id, 'kind', a.kind, 'name', a.name,
      'mime', a.mime, 'bytes', a.bytes, 'width', a.width, 'height', a.height,
      'thumb', case when a.status = 'expired' or a.expires_at <= now() or a.removed_at is not null then null else a.thumb end,
      'expires_at', a.expires_at,
      'expired', (a.status = 'expired' or a.expires_at <= now() or a.removed_at is not null)
    ) order by a.created_at, a.id), '[]'::jsonb)
  from relay.attachments a
  where a.status in ('ready', 'expired')
    and ((a.message_id is not null and a.message_id = any(coalesce(p_message_ids, array[]::uuid[])))
      or (p_room is not null and a.room_id = p_room and a.room_seq = any(coalesce(p_seqs, array[]::bigint[]))));
$function$;

-- 換下載：上傳者、綁定信件的收件節點、綁定群組的有效成員節點才給路徑；不是這些一律 not_found（不洩漏存不存在）
create or replace function public.irori_relay_attach_access(p_node text, p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  a relay.attachments%rowtype;
  v_t uuid := relay.node_tenant(p_node);
  v_ok boolean := false;
begin
  select * into a from relay.attachments where id = p_id and tenant_id is not distinct from v_t and status <> 'pending';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if a.owner_node = p_node then
    v_ok := true;
  elsif a.message_id is not null then
    v_ok := exists (select 1 from relay.messages m where m.id = a.message_id and m.to_node = p_node);
  elsif a.room_id is not null then
    v_ok := exists (select 1 from relay.room_members rm
      where rm.room_id = a.room_id and rm.left_at is null and split_part(rm.member, '~', 1) = p_node);
  end if;
  if not v_ok then
    return jsonb_build_object('error', 'not_found');
  end if;
  if a.status = 'expired' or a.expires_at <= now() or a.removed_at is not null then
    return jsonb_build_object('error', 'expired');
  end if;
  return jsonb_build_object('path', a.storage_path, 'name', a.name, 'mime', a.mime, 'bytes', a.bytes);
end;
$function$;

-- 清理：挑出該從 Storage 刪的檔案（過期、放棄超過 1 小時的上傳），同時標成 expired 並清縮圖
create or replace function public.irori_relay_attach_sweep(p_limit integer)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  with t as (
    select id from relay.attachments
    where removed_at is null
      and (status = 'expired' or expires_at <= now() or (status = 'pending' and created_at < now() - interval '1 hour'))
    order by created_at
    limit least(greatest(coalesce(p_limit, 50), 1), 500)
    for update skip locked
  ), u as (
    update relay.attachments a set status = 'expired', thumb = null
    from t where a.id = t.id
    returning a.id, a.storage_path
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'path', u.storage_path)), '[]'::jsonb) from u;
$function$;

-- 檔案真的刪掉後記時間
create or replace function public.irori_relay_attach_swept(p_ids uuid[])
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_n integer;
begin
  update relay.attachments set removed_at = now()
    where id = any(coalesce(p_ids, array[]::uuid[])) and removed_at is null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('marked', v_n);
end;
$function$;

-- Supabase 預設會把 public 函式開給 anon／authenticated，這裡逐一收回，只留 service_role
revoke all on function public.irori_relay_attach_init(text, text, text, text, integer, integer, integer, text, text, bigint, integer) from public, anon, authenticated;
revoke all on function public.irori_relay_attach_commit(text, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.irori_relay_attach_claim(text, uuid[]) from public, anon, authenticated;
revoke all on function public.irori_relay_attach_bind(text, uuid[], uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.irori_relay_attach_for(uuid[], text, bigint[]) from public, anon, authenticated;
revoke all on function public.irori_relay_attach_access(text, uuid) from public, anon, authenticated;
revoke all on function public.irori_relay_attach_sweep(integer) from public, anon, authenticated;
revoke all on function public.irori_relay_attach_swept(uuid[]) from public, anon, authenticated;
grant execute on function public.irori_relay_attach_init(text, text, text, text, integer, integer, integer, text, text, bigint, integer) to service_role;
grant execute on function public.irori_relay_attach_commit(text, uuid, integer, text) to service_role;
grant execute on function public.irori_relay_attach_claim(text, uuid[]) to service_role;
grant execute on function public.irori_relay_attach_bind(text, uuid[], uuid, text, bigint) to service_role;
grant execute on function public.irori_relay_attach_for(uuid[], text, bigint[]) to service_role;
grant execute on function public.irori_relay_attach_access(text, uuid) to service_role;
grant execute on function public.irori_relay_attach_sweep(integer) to service_role;
grant execute on function public.irori_relay_attach_swept(uuid[]) to service_role;

-- ===== 排程：每天 03:27（UTC）把到期與放棄的上傳標成 expired 並清縮圖；已刪檔超過 90 天的列刪除 =====
-- 實體檔案只能經 Storage API 刪（直接刪 storage.objects 資料列不會刪到底層檔案），由 Edge Function 的 attach_sweep 負責。
create extension if not exists pg_cron;
select cron.unschedule('relay-purge-attachments') where exists (select 1 from cron.job where jobname = 'relay-purge-attachments');
select cron.schedule('relay-purge-attachments', '27 3 * * *', $$
  update relay.attachments set status = 'expired', thumb = null
    where status <> 'expired' and (expires_at < now() or (status = 'pending' and created_at < now() - interval '1 hour'));
  delete from relay.attachments where removed_at is not null and created_at < now() - interval '90 days';
$$);

-- 回復（手動）：
--   select cron.unschedule('relay-purge-attachments');
--   drop table relay.attachments;  以及 drop function public.irori_relay_attach_* ；
--   drop policy attachments_no_client_access on storage.objects;
--   刪 bucket 要先經 Storage API 清空（直接刪資料列不會刪到底層檔案）。
