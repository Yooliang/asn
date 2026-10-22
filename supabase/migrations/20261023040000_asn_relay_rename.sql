-- #14 R6：資料庫函式 public.irori_relay_* 改名為 public.asn_relay_*（零停機、舊版相容）。
--
-- 做法（整支在同一個交易內，可重跑）：
--   1. 每支函式 alter function … rename 成 asn_relay_*（新名已存在就跳過）。權限、函式內容、觸發器綁定都跟著函式本體走（以 oid 為準）。
--   2. 函式內部互相呼叫（例如 partner_sync 呼叫 partner_sync_core）、relay 結構描述裡的函式呼叫，一律改成新名：
--      把函式定義取出、把 irori_relay_ 換成 asn_relay_ 後重建；pg_cron 排程的指令字串也一併改。
--   3. 在舊名建立同簽章（含預設值）的薄包裝：security definer、search_path 空、只呼叫新函式並原樣回傳，
--      讓還在跑舊版 Edge Function 的期間不會壞。新舊名都只授權 service_role。
-- 切換完成、確認不再有舊版呼叫之後，另開 migration 刪掉這些舊名包裝（見 docs/BACKEND.md）。
-- 回復：先 drop 舊名包裝，再把新名 alter function … rename 回舊名；一般情況不需要，包裝與新名行為相同。

begin;

-- 1. 改名（簽章清單由 migrations 推導；部署前用 tools/migrate/list_irori_functions.sql 對照線上）
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('irori_relay_acct_email_ok', 'p_email text'),
      ('irori_relay_acct_expire', ''),
      ('irori_relay_acct_list', 'p_actor text, p_node text'),
      ('irori_relay_acct_report', 'p_node text, p_accounts jsonb'),
      ('irori_relay_acct_switch', 'p_actor text, p_node text, p_vendor text, p_email text'),
      ('irori_relay_acct_switch_pending', 'p_node text'),
      ('irori_relay_acct_switch_result', 'p_node text, p_id uuid, p_status text, p_detail text'),
      ('irori_relay_acct_switch_status', 'p_actor text, p_ids uuid[]'),
      ('irori_relay_ack', 'p_node text, p_ids uuid[]'),
      ('irori_relay_ack_agent', 'p_node text, p_agent text, p_ids uuid[]'),
      ('irori_relay_asn_presence_set', 'p_node text, p_window text, p_version text, p_status text, p_psm text'),
      ('irori_relay_asn_update_poll', 'p_node text, p_version text'),
      ('irori_relay_asn_update_result', 'p_node text, p_ok boolean, p_detail text'),
      ('irori_relay_attach_access', 'p_node text, p_id uuid'),
      ('irori_relay_attach_bind', 'p_node text, p_ids uuid[], p_message_id uuid, p_room text, p_seq bigint'),
      ('irori_relay_attach_claim', 'p_node text, p_ids uuid[]'),
      ('irori_relay_attach_commit', 'p_node text, p_id uuid, p_bytes integer, p_mime text'),
      ('irori_relay_attach_for', 'p_message_ids uuid[], p_room text, p_seqs bigint[]'),
      ('irori_relay_attach_init', 'p_node text, p_kind text, p_mime text, p_name text, p_bytes integer, p_width integer, p_height integer, p_thumb text, p_sha256 text, p_quota_bytes bigint, p_quota_count integer'),
      ('irori_relay_attach_sweep', 'p_limit integer'),
      ('irori_relay_attach_swept', 'p_ids uuid[]'),
      ('irori_relay_auth', 'p_key_hash text'),
      ('irori_relay_get_avatar', 'p_tenant uuid, p_node text'),
      ('irori_relay_inbox', 'p_node text, p_exclude_agents text[]'),
      ('irori_relay_inbox_agent', 'p_node text, p_agent text'),
      ('irori_relay_inbox_peek', 'p_node text, p_agent text'),
      ('irori_relay_invite', 'p_node text, p_code_hash text, p_note text'),
      ('irori_relay_launch', 'p_actor text, p_node text, p_profile text, p_name text, p_cwd text, p_first text, p_signed_user uuid'),
      ('irori_relay_launch_name_ok', 'p_name text'),
      ('irori_relay_launch_pending', 'p_node text'),
      ('irori_relay_launch_result', 'p_node text, p_id uuid, p_status text, p_detail text'),
      ('irori_relay_launchers', 'p_actor text, p_ids uuid[], p_signed_user uuid'),
      ('irori_relay_leave', 'p_node text'),
      ('irori_relay_list', 'p_tenant uuid'),
      ('irori_relay_partner_archive', 'p_actor text, p_signed_user uuid, p_node text, p_name text, p_partner_id text, p_archived boolean'),
      ('irori_relay_partner_list', 'p_user uuid, p_caller text'),
      ('irori_relay_partner_op', 'p_actor text, p_signed_user uuid, p_node text, p_name text, p_op text, p_new_name text, p_model text, p_note text'),
      ('irori_relay_partner_op_pending', 'p_node text'),
      ('irori_relay_partner_op_progress', 'p_node text, p_id uuid, p_detail text'),
      ('irori_relay_partner_op_result', 'p_node text, p_id uuid, p_status text, p_detail text, p_result jsonb'),
      ('irori_relay_partner_ops', 'p_actor text, p_signed_user uuid, p_ids uuid[]'),
      ('irori_relay_partner_succeed', 'p_user uuid, p_caller text, p_predecessor text, p_node text, p_name text'),
      ('irori_relay_partner_sync', 'p_node text, p_windows jsonb'),
      ('irori_relay_partner_sync_core', 'p_node text, p_windows jsonb'),
      ('irori_relay_redeem_reissue', 'p_ip_hash text, p_code_hash text, p_id text, p_key_hash text, p_bell_topic text'),
      ('irori_relay_register', 'p_ip_hash text, p_code_hash text, p_id text, p_name text, p_kind text, p_machine text, p_note text, p_key_hash text, p_bell_topic text'),
      ('irori_relay_reissue', 'p_node text, p_code_hash text, p_id text'),
      ('irori_relay_room_add', 'p_actor text, p_room text, p_member text'),
      ('irori_relay_room_auto_apply', 'p_node text, p_joins jsonb'),
      ('irori_relay_room_auto_rules', ''),
      ('irori_relay_room_auto_rules', 'p_node text'),
      ('irori_relay_room_create', 'p_actor text, p_id text, p_name text, p_members text[]'),
      ('irori_relay_room_list', 'p_node text, p_owner boolean'),
      ('irori_relay_room_members', 'p_node text, p_agent text, p_room text, p_owner boolean'),
      ('irori_relay_room_pin_get', 'p_node text, p_agent text, p_room text, p_owner boolean'),
      ('irori_relay_room_pin_set', 'p_actor text, p_room text, p_body text, p_version integer'),
      ('irori_relay_room_post', 'p_node text, p_agent text, p_room text, p_body text, p_mentions text[], p_owner boolean, p_signed_user uuid'),
      ('irori_relay_room_read', 'p_node text, p_agent text, p_room text, p_since bigint, p_limit integer, p_owner boolean, p_tail boolean, p_mark boolean'),
      ('irori_relay_room_remove', 'p_actor text, p_room text, p_member text'),
      ('irori_relay_room_set_prefixes', 'p_actor text, p_room text, p_prefixes text[]'),
      ('irori_relay_roster', 'p_node text, p_agents jsonb'),
      ('irori_relay_roster_has', 'p_node text, p_name text'),
      ('irori_relay_send', 'p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid, p_expects_reply boolean, p_signed_user uuid, p_as_person boolean'),
      ('irori_relay_sent_status', 'p_node text, p_ids uuid[]'),
      ('irori_relay_set_avatar', 'p_node text, p_avatar text'),
      ('irori_relay_set_launcher', 'p_node text, p_launcher jsonb'),
      ('irori_relay_set_self_name', 'p_node text, p_name text'),
      ('irori_relay_update', 'p_node text, p_id text, p_machine text, p_name text'),
      ('irori_relay_whoami', 'p_tenant uuid')
    ) as t(old_name, ident)
  loop
    if not exists (
      select 1 from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname = 'asn_relay_' || substr(r.old_name, length('irori_relay_') + 1)
         and pg_get_function_identity_arguments(p.oid) = r.ident
    ) then
      execute format('alter function public.%I(%s) rename to %I', r.old_name, r.ident, 'asn_relay_' || substr(r.old_name, length('irori_relay_') + 1));
    end if;
  end loop;
end
$$;

-- 2. 內部呼叫改新名：public 與 relay 結構描述裡，函式內容還出現 irori_relay_ 的
--    （包裝函式此時還沒建立；重跑時包裝內容只有新名，不會被選中）
do $$
declare
  r record;
begin
  for r in
    select p.oid
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'relay')
       and p.prokind = 'f'
       and p.prosrc like '%irori\_relay\_%'
  loop
    execute replace(pg_get_functiondef(r.oid), 'irori_relay_', 'asn_relay_');
  end loop;
end
$$;

-- pg_cron 排程指令裡的舊名（目前排程都不呼叫這些函式，保險起見仍掃一遍；沒有 cron 或沒有權限就略過）
do $$
begin
  if to_regclass('cron.job') is not null then
    update cron.job set command = replace(command, 'irori_relay_', 'asn_relay_') where command like '%irori\_relay\_%';
  end if;
exception when others then
  raise notice '略過 pg_cron 排程更新：%', sqlerrm;
end
$$;

-- 3. 舊名薄包裝

create or replace function public.irori_relay_acct_email_ok(p_email text)
 returns boolean
 language sql
 immutable
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_acct_email_ok(p_email);
$function$;

create or replace function public.irori_relay_acct_expire()
 returns void
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_acct_expire();
$function$;

create or replace function public.irori_relay_acct_list(p_actor text, p_node text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_acct_list(p_actor, p_node);
$function$;

create or replace function public.irori_relay_acct_report(p_node text, p_accounts jsonb)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_acct_report(p_node, p_accounts);
$function$;

create or replace function public.irori_relay_acct_switch(p_actor text, p_node text, p_vendor text, p_email text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_acct_switch(p_actor, p_node, p_vendor, p_email);
$function$;

create or replace function public.irori_relay_acct_switch_pending(p_node text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_acct_switch_pending(p_node);
$function$;

create or replace function public.irori_relay_acct_switch_result(p_node text, p_id uuid, p_status text, p_detail text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_acct_switch_result(p_node, p_id, p_status, p_detail);
$function$;

create or replace function public.irori_relay_acct_switch_status(p_actor text, p_ids uuid[])
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_acct_switch_status(p_actor, p_ids);
$function$;

create or replace function public.irori_relay_ack(p_node text, p_ids uuid[])
 returns integer
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_ack(p_node, p_ids);
$function$;

create or replace function public.irori_relay_ack_agent(p_node text, p_agent text, p_ids uuid[])
 returns integer
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_ack_agent(p_node, p_agent, p_ids);
$function$;

create or replace function public.irori_relay_asn_presence_set(p_node text, p_window text, p_version text, p_status text, p_psm text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_asn_presence_set(p_node, p_window, p_version, p_status, p_psm);
$function$;

create or replace function public.irori_relay_asn_update_poll(p_node text, p_version text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_asn_update_poll(p_node, p_version);
$function$;

create or replace function public.irori_relay_asn_update_result(p_node text, p_ok boolean, p_detail text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_asn_update_result(p_node, p_ok, p_detail);
$function$;

create or replace function public.irori_relay_attach_access(p_node text, p_id uuid)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_attach_access(p_node, p_id);
$function$;

create or replace function public.irori_relay_attach_bind(p_node text, p_ids uuid[], p_message_id uuid, p_room text, p_seq bigint)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_attach_bind(p_node, p_ids, p_message_id, p_room, p_seq);
$function$;

create or replace function public.irori_relay_attach_claim(p_node text, p_ids uuid[])
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_attach_claim(p_node, p_ids);
$function$;

create or replace function public.irori_relay_attach_commit(p_node text, p_id uuid, p_bytes integer, p_mime text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_attach_commit(p_node, p_id, p_bytes, p_mime);
$function$;

create or replace function public.irori_relay_attach_for(p_message_ids uuid[], p_room text, p_seqs bigint[])
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_attach_for(p_message_ids, p_room, p_seqs);
$function$;

create or replace function public.irori_relay_attach_init(p_node text, p_kind text, p_mime text, p_name text, p_bytes integer, p_width integer, p_height integer, p_thumb text, p_sha256 text, p_quota_bytes bigint, p_quota_count integer)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_attach_init(p_node, p_kind, p_mime, p_name, p_bytes, p_width, p_height, p_thumb, p_sha256, p_quota_bytes, p_quota_count);
$function$;

create or replace function public.irori_relay_attach_sweep(p_limit integer)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_attach_sweep(p_limit);
$function$;

create or replace function public.irori_relay_attach_swept(p_ids uuid[])
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_attach_swept(p_ids);
$function$;

create or replace function public.irori_relay_auth(p_key_hash text)
 returns TABLE(id text, bell_topic text, role text, can_invite boolean, tenant_id uuid)
 language sql
 security definer
 set search_path to ''
as $function$
  select * from public.asn_relay_auth(p_key_hash);
$function$;

create or replace function public.irori_relay_get_avatar(p_tenant uuid, p_node text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_get_avatar(p_tenant, p_node);
$function$;

create or replace function public.irori_relay_inbox(p_node text, p_exclude_agents text[] DEFAULT NULL::text[])
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_inbox(p_node, p_exclude_agents);
$function$;

create or replace function public.irori_relay_inbox_agent(p_node text, p_agent text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_inbox_agent(p_node, p_agent);
$function$;

create or replace function public.irori_relay_inbox_peek(p_node text, p_agent text)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_inbox_peek(p_node, p_agent);
$function$;

create or replace function public.irori_relay_invite(p_node text, p_code_hash text, p_note text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_invite(p_node, p_code_hash, p_note);
$function$;

create or replace function public.irori_relay_launch(p_actor text, p_node text, p_profile text, p_name text, p_cwd text, p_first text, p_signed_user uuid DEFAULT NULL::uuid)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_launch(p_actor, p_node, p_profile, p_name, p_cwd, p_first, p_signed_user);
$function$;

create or replace function public.irori_relay_launch_name_ok(p_name text)
 returns boolean
 language sql
 immutable
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_launch_name_ok(p_name);
$function$;

create or replace function public.irori_relay_launch_pending(p_node text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_launch_pending(p_node);
$function$;

create or replace function public.irori_relay_launch_result(p_node text, p_id uuid, p_status text, p_detail text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_launch_result(p_node, p_id, p_status, p_detail);
$function$;

create or replace function public.irori_relay_launchers(p_actor text, p_ids uuid[], p_signed_user uuid DEFAULT NULL::uuid)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_launchers(p_actor, p_ids, p_signed_user);
$function$;

create or replace function public.irori_relay_leave(p_node text)
 returns boolean
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_leave(p_node);
$function$;

create or replace function public.irori_relay_list(p_tenant uuid)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_list(p_tenant);
$function$;

create or replace function public.irori_relay_partner_archive(p_actor text, p_signed_user uuid, p_node text, p_name text, p_partner_id text, p_archived boolean)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_partner_archive(p_actor, p_signed_user, p_node, p_name, p_partner_id, p_archived);
$function$;

create or replace function public.irori_relay_partner_list(p_user uuid, p_caller text)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_partner_list(p_user, p_caller);
$function$;

create or replace function public.irori_relay_partner_op(p_actor text, p_signed_user uuid, p_node text, p_name text, p_op text, p_new_name text, p_model text, p_note text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_partner_op(p_actor, p_signed_user, p_node, p_name, p_op, p_new_name, p_model, p_note);
$function$;

create or replace function public.irori_relay_partner_op_pending(p_node text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_partner_op_pending(p_node);
$function$;

create or replace function public.irori_relay_partner_op_progress(p_node text, p_id uuid, p_detail text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_partner_op_progress(p_node, p_id, p_detail);
$function$;

create or replace function public.irori_relay_partner_op_result(p_node text, p_id uuid, p_status text, p_detail text, p_result jsonb)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_partner_op_result(p_node, p_id, p_status, p_detail, p_result);
$function$;

create or replace function public.irori_relay_partner_ops(p_actor text, p_signed_user uuid, p_ids uuid[])
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_partner_ops(p_actor, p_signed_user, p_ids);
$function$;

create or replace function public.irori_relay_partner_succeed(p_user uuid, p_caller text, p_predecessor text, p_node text, p_name text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_partner_succeed(p_user, p_caller, p_predecessor, p_node, p_name);
$function$;

create or replace function public.irori_relay_partner_sync(p_node text, p_windows jsonb)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_partner_sync(p_node, p_windows);
$function$;

create or replace function public.irori_relay_partner_sync_core(p_node text, p_windows jsonb)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_partner_sync_core(p_node, p_windows);
$function$;

create or replace function public.irori_relay_redeem_reissue(p_ip_hash text, p_code_hash text, p_id text, p_key_hash text, p_bell_topic text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_redeem_reissue(p_ip_hash, p_code_hash, p_id, p_key_hash, p_bell_topic);
$function$;

create or replace function public.irori_relay_register(p_ip_hash text, p_code_hash text, p_id text, p_name text, p_kind text, p_machine text, p_note text, p_key_hash text, p_bell_topic text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_register(p_ip_hash, p_code_hash, p_id, p_name, p_kind, p_machine, p_note, p_key_hash, p_bell_topic);
$function$;

create or replace function public.irori_relay_reissue(p_node text, p_code_hash text, p_id text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_reissue(p_node, p_code_hash, p_id);
$function$;

create or replace function public.irori_relay_room_add(p_actor text, p_room text, p_member text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_room_add(p_actor, p_room, p_member);
$function$;

create or replace function public.irori_relay_room_auto_apply(p_node text, p_joins jsonb)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_room_auto_apply(p_node, p_joins);
$function$;

create or replace function public.irori_relay_room_auto_rules()
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_room_auto_rules();
$function$;

create or replace function public.irori_relay_room_auto_rules(p_node text)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_room_auto_rules(p_node);
$function$;

create or replace function public.irori_relay_room_create(p_actor text, p_id text, p_name text, p_members text[])
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_room_create(p_actor, p_id, p_name, p_members);
$function$;

create or replace function public.irori_relay_room_list(p_node text, p_owner boolean DEFAULT false)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_room_list(p_node, p_owner);
$function$;

create or replace function public.irori_relay_room_members(p_node text, p_agent text, p_room text, p_owner boolean DEFAULT false)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_room_members(p_node, p_agent, p_room, p_owner);
$function$;

create or replace function public.irori_relay_room_pin_get(p_node text, p_agent text, p_room text, p_owner boolean DEFAULT false)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_room_pin_get(p_node, p_agent, p_room, p_owner);
$function$;

create or replace function public.irori_relay_room_pin_set(p_actor text, p_room text, p_body text, p_version integer)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_room_pin_set(p_actor, p_room, p_body, p_version);
$function$;

create or replace function public.irori_relay_room_post(p_node text, p_agent text, p_room text, p_body text, p_mentions text[], p_owner boolean DEFAULT false, p_signed_user uuid DEFAULT NULL::uuid)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_room_post(p_node, p_agent, p_room, p_body, p_mentions, p_owner, p_signed_user);
$function$;

create or replace function public.irori_relay_room_read(p_node text, p_agent text, p_room text, p_since bigint, p_limit integer, p_owner boolean DEFAULT false, p_tail boolean DEFAULT false, p_mark boolean DEFAULT NULL::boolean)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_room_read(p_node, p_agent, p_room, p_since, p_limit, p_owner, p_tail, p_mark);
$function$;

create or replace function public.irori_relay_room_remove(p_actor text, p_room text, p_member text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_room_remove(p_actor, p_room, p_member);
$function$;

create or replace function public.irori_relay_room_set_prefixes(p_actor text, p_room text, p_prefixes text[])
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_room_set_prefixes(p_actor, p_room, p_prefixes);
$function$;

create or replace function public.irori_relay_roster(p_node text, p_agents jsonb)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_roster(p_node, p_agents);
$function$;

create or replace function public.irori_relay_roster_has(p_node text, p_name text)
 returns boolean
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_roster_has(p_node, p_name);
$function$;

create or replace function public.irori_relay_send(p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid, p_expects_reply boolean DEFAULT NULL::boolean, p_signed_user uuid DEFAULT NULL::uuid, p_as_person boolean DEFAULT false)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_send(p_from_node, p_from_agent, p_to_node, p_to_agent, p_body, p_reply_to, p_expects_reply, p_signed_user, p_as_person);
$function$;

create or replace function public.irori_relay_sent_status(p_node text, p_ids uuid[])
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_sent_status(p_node, p_ids);
$function$;

create or replace function public.irori_relay_set_avatar(p_node text, p_avatar text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_set_avatar(p_node, p_avatar);
$function$;

create or replace function public.irori_relay_set_launcher(p_node text, p_launcher jsonb)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_set_launcher(p_node, p_launcher);
$function$;

create or replace function public.irori_relay_set_self_name(p_node text, p_name text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_set_self_name(p_node, p_name);
$function$;

create or replace function public.irori_relay_update(p_node text, p_id text, p_machine text, p_name text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_update(p_node, p_id, p_machine, p_name);
$function$;

create or replace function public.irori_relay_whoami(p_tenant uuid)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select public.asn_relay_whoami(p_tenant);
$function$;

-- 4. 權限：新舊名都只給 service_role
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and (p.proname like 'irori\_relay\_%' or p.proname like 'asn\_relay\_%')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end
$$;

commit;
