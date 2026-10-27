-- 0.2 H2：設備回報自己的平台與「不開放開新夥伴」的原因，開新夥伴精靈才寫得出對的說明。
-- 1. relay.nodes 加兩個可為 null 的欄位：
--    platform：只收 linux／windows／macos，其餘一律存 null（不存任意字串）；舊的機器橋不帶＝null，精靈照原本的說法。
--    launch_closed_reason：那台自己在 launcher.json 寫的原因（{"remote_launch": false, "reason": "…"}），會顯示在同帳號其他設備的精靈上，
--    所以只收純文字：控制字元換空白、去頭尾空白、最多 120 字，空字串存 null。
-- 2. asn_relay_set_platform：機器橋附在名單回報（relay 函式另做一次格式檢查）。只改自己節點。
-- 3. asn_relay_launchers：多回 platform、launch_closed_reason；沒開放但有回報平台或原因的設備也列出來（launcher 仍是 null，照舊算沒開放）。
--    函式本體照正式庫現行定義（部署前已比對），只改 machines 那一段。
-- 只加欄位與函式，不改舊值；舊版用戶端不認得新欄位就略過。部署順序：migration → relay 函式 → 機器橋與用戶端。
begin;

alter table relay.nodes add column if not exists platform text;
alter table relay.nodes add column if not exists launch_closed_reason text;
alter table relay.nodes drop constraint if exists nodes_platform_check;
alter table relay.nodes add constraint nodes_platform_check check (platform is null or platform in ('linux', 'windows', 'macos'));
alter table relay.nodes drop constraint if exists nodes_launch_closed_reason_check;
alter table relay.nodes add constraint nodes_launch_closed_reason_check
  check (launch_closed_reason is null or (char_length(launch_closed_reason) between 1 and 120 and launch_closed_reason !~ '[[:cntrl:]]'));

create or replace function public.asn_relay_set_platform(p_node text, p_platform text, p_closed_reason text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_reason text;
begin
  v_reason := nullif(btrim(regexp_replace(coalesce(p_closed_reason, ''), '[[:cntrl:]]', ' ', 'g')), '');
  if v_reason is not null then
    v_reason := btrim(left(v_reason, 120));
  end if;
  update relay.nodes set
      platform = case when p_platform in ('linux', 'windows', 'macos') then p_platform end,
      launch_closed_reason = v_reason
    where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.asn_relay_set_platform(text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_set_platform(text, text, text) to service_role;

create or replace function public.asn_relay_launchers(p_actor text, p_ids uuid[], p_signed_user uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_mach jsonb; v_recent jsonb; v_t uuid;
begin
  select tenant_id into v_t from relay.nodes
    where id = p_actor and status = 'active'
      and (role = 'owner' or public.asn_user_owns_node(p_signed_user, p_actor));
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'node', n.id, 'name', n.name, 'machine', n.machine, 'launcher', n.launcher, 'launcher_at', n.launcher_at,
      'platform', n.platform, 'launch_closed_reason', n.launch_closed_reason,
      'online', coalesce(n.last_seen_at > now() - interval '3 minutes', false)) order by n.id), '[]'::jsonb)
    into v_mach from relay.nodes n
    where n.status = 'active' and (n.launcher is not null or n.platform is not null or n.launch_closed_reason is not null)
      and n.tenant_id is not distinct from v_t;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'node', l.node, 'profile', l.profile, 'name', l.name, 'cwd', l.cwd,
      'status', case when l.status = 'pending' and l.created_at <= now() - interval '2 minutes' then 'failed' else l.status end,
      'detail', case when l.status = 'pending' and l.created_at <= now() - interval '2 minutes'
                     then '機器橋 2 分鐘內沒有取走（電腦可能沒開或橋沒在跑）' else l.detail end,
      'created_at', l.created_at, 'done_at', l.done_at) order by l.created_at desc), '[]'::jsonb)
    into v_recent from (
      select * from relay.launches
      where tenant_id is not distinct from v_t
        and ((p_ids is null and created_at > now() - interval '7 days') or id = any(p_ids))
      order by created_at desc limit 30
    ) l;
  return jsonb_build_object('machines', v_mach, 'launches', v_recent);
end;
$function$;

commit;
