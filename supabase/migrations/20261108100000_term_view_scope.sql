-- 別台打字（0.2.10 PR①）：觀看控制面分「看畫面」（view）和「打字」（input）兩種工作階段。D＝發起的那台，T＝被看／被打字的那台。
-- 設計（asn真 定案，0.2.8 改版後重寫：沒有配對，信任是兩台本機各自記住的設備公鑰 TOFU）：
--   * 打字另起一筆、另一個 topic（ti_ 開頭），不和看畫面共用；畫面照舊由看畫面那一筆送。
--   * **後台不決定 T 同不同意：** 同意只在 T 本機（每次跳 ASN 的系統對話框，或本人在 T 的 ASN 畫面對某台設「不用每次同意」）。
--     後台只存 scope、原樣交給 T（pending 帶 scope），T 依本機設定決定接受或拒絕。scope 由兩端簽進握手，後台只轉交。
--   * 上限分開算：看畫面每台 T 同時 3 個（照舊）；打字每台 T 同時 1 個。D 每小時發起 30 次（兩種合計，照舊）。
--   * 到期兩種都最多 10 分鐘（照舊）。打字「閒置 2 分鐘就結束」看的是有沒有打字，後台看不到內容，由 T 本機判斷。
--   * D 重開後再發起：只結束「同一對、同一個視窗、同一種」的舊那筆（開打字不會把正在看的那筆關掉）。
--   * 通知本人的文字依 scope 寫清楚：打字＝可以在這台打任何字，包括回答權限框。
--   * topic 前綴和 scope 綁在一起（表上檢查）。
--   * 線上 Edge（不帶 p_scope）照舊呼叫八個參數的 start：改成轉呼叫新版、scope＝view，行為不變。
-- 先不用：舊版不會發起打字；沒帶 scope 的一律是看畫面。
-- 回復：drop 九個參數的 asn_relay_term_view_start；重跑 20261107110000 的 start（八個參數）／pending／notice；
--       alter table relay.term_views drop constraint term_views_scope_check, drop constraint term_views_scope_topic_check, drop column scope。
begin;

alter table relay.term_views add column if not exists scope text not null default 'view';
alter table relay.term_views drop constraint if exists term_views_scope_check;
alter table relay.term_views add constraint term_views_scope_check check (scope = any (array['view', 'input']));
alter table relay.term_views drop constraint if exists term_views_scope_topic_check;
alter table relay.term_views add constraint term_views_scope_topic_check check (
  topic is null or (scope = 'view' and topic like 'tv\_%') or (scope = 'input' and topic like 'ti\_%'));

-- D 發起（本人簽章），新版：多帶 scope。回 topic、T 的門鈴、T 的設備公鑰、scope
create or replace function public.asn_relay_term_view_start(p_actor text, p_signed_user uuid, p_id uuid, p_to_node text, p_window_name text, p_d_eph_pub text, p_d_sig text, p_expires_at timestamptz, p_scope text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_topic text;
  v_bell text;
  v_to_pub text;
  v_max int;
begin
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_id is null or p_to_node is null or p_to_node = p_actor
     or p_window_name is null or char_length(p_window_name) not between 1 and 64 or p_window_name ~ '[[:cntrl:]]'
     or p_d_eph_pub is null or p_d_eph_pub !~ '^[A-Za-z0-9_-]{43}$'
     or p_d_sig is null or p_d_sig !~ '^[A-Za-z0-9_-]+$' or char_length(p_d_sig) not between 86 and 700
     or p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '10 minutes 30 seconds'
     or p_scope is null or p_scope not in ('view', 'input') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not public.asn_user_owns_node(p_signed_user, p_to_node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  perform public.asn_relay_term_view_expire();
  if exists (select 1 from relay.term_views where id = p_id) then
    return jsonb_build_object('error', 'bad_request');   -- session id 不能重用
  end if;
  -- D 重開後再發起同一個視窗、同一種：舊的那筆已經沒有人在用，結束它再開新的
  update relay.term_views
    set status = 'ended', end_reason = 'viewer_ended', ended_at = now(), topic = null, d_eph_pub = null, d_sig = null, t_eph_pub = null, t_sig = null
    where from_node = p_actor and to_node = p_to_node and window_name = p_window_name and scope = p_scope and status <> 'ended';
  v_max := case p_scope when 'input' then 1 else 3 end;
  if (select count(*) from relay.term_views where to_node = p_to_node and scope = p_scope and status <> 'ended') >= v_max then
    return jsonb_build_object('error', 'busy');
  end if;
  if (select count(*) from relay.term_views where from_node = p_actor and created_at > now() - interval '1 hour') >= 30 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  select bell_topic into v_bell from relay.nodes where id = p_to_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  select sign_pub into v_to_pub from relay.device_keys where node = p_to_node;
  if not found then
    return jsonb_build_object('error', 'no_key');
  end if;
  v_topic := case p_scope when 'input' then 'ti_' else 'tv_' end
    || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into relay.term_views (id, from_node, to_node, window_name, scope, topic, d_eph_pub, d_sig, expires_at)
    values (p_id, p_actor, p_to_node, p_window_name, p_scope, v_topic, p_d_eph_pub, p_d_sig, p_expires_at);
  return jsonb_build_object('id', p_id, 'topic', v_topic, 'bell_topic', v_bell, 'to_pub', v_to_pub, 'scope', p_scope);
end;
$function$;

-- 舊版（八個參數，線上 Edge 在用）：一律是看畫面，轉呼叫新版
create or replace function public.asn_relay_term_view_start(p_actor text, p_signed_user uuid, p_id uuid, p_to_node text, p_window_name text, p_d_eph_pub text, p_d_sig text, p_expires_at timestamptz)
 returns jsonb language sql security definer set search_path to ''
as $function$
  select public.asn_relay_term_view_start(p_actor, p_signed_user, p_id, p_to_node, p_window_name, p_d_eph_pub, p_d_sig, p_expires_at, 'view'::text);
$function$;

-- T 領取（節點金鑰）：多帶 scope，T 依本機設定決定要不要接受（打字預設要本人在 T 按同意）
create or replace function public.asn_relay_term_view_pending(p_node text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_req jsonb;
  v_act jsonb;
begin
  perform public.asn_relay_term_view_expire();
  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'scope', v.scope, 'from_node', v.from_node, 'from_name', n.name, 'from_pub', k.sign_pub, 'window_name', v.window_name, 'topic', v.topic,
      'd_eph_pub', v.d_eph_pub, 'd_sig', v.d_sig, 'expires_s', extract(epoch from v.expires_at)::bigint) order by v.created_at), '[]'::jsonb)
    into v_req
    from relay.term_views v join relay.nodes n on n.id = v.from_node join relay.device_keys k on k.node = v.from_node
    where v.to_node = p_node and v.status = 'requested';
  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'scope', v.scope, 'status', v.status, 'viewer_stale', v.viewer_seen_at < now() - interval '90 seconds')), '[]'::jsonb)
    into v_act
    from relay.term_views v
    where v.to_node = p_node and v.status in ('accepted', 'watching', 'paused');
  return jsonb_build_object('requests', v_req, 'active', v_act);
end;
$function$;

-- T 通知本人（節點金鑰）：文字依 scope。收件人、寄件名、文字都在這裡決定，T 只能指定是哪一筆
create or replace function public.asn_relay_term_view_notice(p_node text, p_id uuid)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  r relay.term_views%rowtype;
  v_owner uuid;
  v_computer text;
  v_viewer text;
  v_window text;
  v_body text;
  v_recent int;
  v_res jsonb;
  v_topics jsonb := '[]'::jsonb;
  v_agent constant text := '看畫面收發室';
begin
  select * into r from relay.term_views where id = p_id and to_node = p_node and status in ('accepted', 'watching', 'paused') for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if r.notified_at is not null then
    return jsonb_build_object('ok', true, 'notify', 'sent', 'bell_topics', '[]'::jsonb);
  end if;
  select owner_user, left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_owner, v_computer
    from relay.nodes where id = p_node and status = 'active';
  if not found or v_owner is null or not public.asn_user_owns_node(v_owner, p_node) then
    return jsonb_build_object('ok', true, 'notify', 'skipped', 'bell_topics', '[]'::jsonb);
  end if;
  select left(btrim(regexp_replace(coalesce(name, ''), '[[:cntrl:]]', '', 'g')), 40) into v_viewer from relay.nodes where id = r.from_node;
  perform pg_advisory_xact_lock(hashtext('term_view_notice:' || p_node));
  select count(distinct coalesce(fanout_id, id)) into v_recent from relay.messages
    where from_node = p_node and from_agent = v_agent and created_at > now() - interval '1 hour';
  if v_recent >= 30 then
    return jsonb_build_object('ok', true, 'notify', 'rate_limited', 'bell_topics', '[]'::jsonb);
  end if;
  v_window := left(regexp_replace(r.window_name, '[[:cntrl:]]', '', 'g'), 64);
  if r.scope = 'input' then
    v_body := '「' || coalesce(v_viewer, '另一台電腦') || '」正在操作這台（' || v_computer || '）夥伴「' || v_window
      || '」的終端：可以在這台打任何字，包括回答權限框。如果不是你，請馬上到這台按結束，並到設定頁「認得的電腦」檢查。';
  else
    v_body := '「' || coalesce(v_viewer, '另一台電腦') || '」正在看這台（' || v_computer || '）夥伴「' || v_window
      || '」的畫面。如果不是你，請到這台按結束，並到設定頁「認得的電腦」檢查。';
  end if;
  v_res := public.asn_relay_send(p_node, v_agent, public.asn_person_alias(v_owner), null, v_body, null, false, null, false);
  if v_res is null or v_res ? 'error' then
    return jsonb_build_object('ok', true, 'notify', 'failed', 'bell_topics', '[]'::jsonb);
  end if;
  update relay.term_views set notified_at = now() where id = r.id;
  v_topics := case
    when jsonb_typeof(v_res->'bell_topics') = 'array' then v_res->'bell_topics'
    when jsonb_typeof(v_res->'bell_topic') = 'string' then jsonb_build_array(v_res->'bell_topic')
    else '[]'::jsonb end;
  return jsonb_build_object('ok', true, 'notify', 'sent', 'bell_topics', v_topics);
end;
$function$;

revoke all on function public.asn_relay_term_view_start(text, uuid, uuid, text, text, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.asn_relay_term_view_start(text, uuid, uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.asn_relay_term_view_pending(text) from public, anon, authenticated;
revoke all on function public.asn_relay_term_view_notice(text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_term_view_start(text, uuid, uuid, text, text, text, text, timestamptz, text) to service_role;
grant execute on function public.asn_relay_term_view_start(text, uuid, uuid, text, text, text, text, timestamptz) to service_role;
grant execute on function public.asn_relay_term_view_pending(text) to service_role;
grant execute on function public.asn_relay_term_view_notice(text, uuid) to service_role;

commit;
