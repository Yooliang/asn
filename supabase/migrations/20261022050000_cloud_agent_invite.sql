-- 雲端代理邀請（issue #13，設計見 docs/design/ONBOARDING.md 第 4 節）：
-- 已登入的本人在 ASN 設定頁替雲端代理建立節點（金鑰只在建立當下回給本人一次）、列出自己邀請過的雲端代理、撤銷。
-- 身分一律由 Edge Function 驗過登入憑證後帶入 p_user；這裡所有函式只授權 service_role。
--  1. nodes.created_via 多一個值 'cloud-invite'（既有值不變）。
--  2. asn_cloud_node_create：金鑰與門鈴頻道由 Edge Function 產生，這裡只收金鑰雜湊（金鑰本身不進資料庫、也不進稽核）。
--     新節點的 last_seen_at 為空＝代理還沒上線過。每個帳號最多 20 個節點（與電腦共用）、其中雲端代理最多 10 個。
--  3. asn_cloud_node_list：只回「自己邀請建立的雲端代理」，不含金鑰雜湊與門鈴頻道。
--  4. asn_cloud_node_revoke：只能撤銷自己名下、created_via = 'cloud-invite' 的啟用中節點；其餘（別人的、電腦、不存在）一律 not_found。
--     撤銷＝節點標為 left，金鑰雜湊與門鈴頻道換成無法對上的值（金鑰立即失效，舊的門鈴頻道也不再有用）。信件保留到 90 天排程刪除。
-- 先不套用：部署由負責的 session 處理。回復做法：supabase/sql/rollback/20261022050000_cloud_agent_invite_down.sql
begin;

alter table relay.nodes drop constraint if exists nodes_created_via_check;
alter table relay.nodes add constraint nodes_created_via_check
  check (created_via is null or created_via in ('login-device', 'claim-existing', 'cloud-invite'));

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
  if (select count(*) from relay.nodes where owner_user = p_user and status = 'active') >= 20
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
revoke all on function public.asn_cloud_node_create(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_cloud_node_create(uuid, text, text, text) to service_role;

create or replace function public.asn_cloud_node_list(p_user uuid)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id, 'name', n.name, 'created_at', n.created_at, 'last_seen_at', n.last_seen_at,
    'online', coalesce(n.last_seen_at > now() - interval '3 minutes', false)) order by n.created_at), '[]'::jsonb)
  from relay.nodes n
  where n.owner_user = p_user and n.status = 'active' and n.created_via = 'cloud-invite';
$function$;
revoke all on function public.asn_cloud_node_list(uuid) from public, anon, authenticated;
grant execute on function public.asn_cloud_node_list(uuid) to service_role;

create or replace function public.asn_cloud_node_revoke(p_user uuid, p_node text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  update relay.nodes
     set status = 'left',
         key_hash = 'revoked:' || gen_random_uuid()::text,
         bell_topic = 'revoked-bell-' || gen_random_uuid()::text
   where id = p_node and owner_user = p_user and status = 'active' and created_via = 'cloud-invite'
     and p_user is not null;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  insert into relay.account_events (user_id, event, node) values (p_user, 'cloud_node_revoked', p_node);
  return jsonb_build_object('ok', true);
end;
$function$;
revoke all on function public.asn_cloud_node_revoke(uuid, text) from public, anon, authenticated;
grant execute on function public.asn_cloud_node_revoke(uuid, text) to service_role;

commit;
