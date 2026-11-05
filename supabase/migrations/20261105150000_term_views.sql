-- 別台看畫面的控制面（#597 工作包 E）。D＝看的那台，T＝被看的那台。
-- 這張表**沒有任何畫面內容**，只有誰、哪台、哪個視窗、狀態，和握手用的一次性公鑰與簽章。畫面是端對端加密，不經過這裡。
-- 設計：
--   * 發起要本人簽章，兩台都是本人的。T 可能沒人在，所以 T 用節點金鑰。
--   * 後台不判斷信任：簽章由兩端用本機記的公鑰驗，後台只轉交。session id 和到期時間由 D 決定並簽進去，後台只檢查範圍。
--     到期時間回整數秒（expires_s）：簽章要逐字相同，不能靠時間字串。
--   * **沒有自由欄位：** D 只能回報固定狀態（watching、paused、ended），T 只能結束。所以沒有 D 傳內容給 T 的路。
--   * 同時最多 3 個；同一對加同一視窗一筆；到期最多 10 分鐘；D 太久沒回報，T 看得到 viewer_stale，自己停。
--   * 結束就清掉一次性公鑰、簽章、topic，只留誰、哪台、哪個視窗、起訖。一天後刪除。
-- 先不用：舊版不會呼叫這幾個動作。Hello 接上之前，電腦端不會真的發起。
-- 回復：drop 這些函式與 relay.term_views。
begin;

create table if not exists relay.term_views (
  id uuid not null,
  from_node text not null,
  to_node text not null,
  window_name text not null,
  topic text,
  d_eph_pub text,
  d_sig text,
  t_eph_pub text,
  t_sig text,
  status text not null default 'requested',
  end_reason text,
  viewer_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  constraint term_views_pkey primary key (id),
  constraint term_views_distinct check (from_node <> to_node),
  constraint term_views_window_check check (char_length(window_name) between 1 and 64),
  constraint term_views_status_check check (status = any (array['requested','accepted','watching','paused','ended'])),
  constraint term_views_reason_check check (end_reason is null or end_reason = any (array['expired','viewer_ended','target_ended','rejected','viewer_gone','failed'])),
  -- 結束就不留金鑰材料
  constraint term_views_clean_after_end check (status <> 'ended' or (topic is null and d_eph_pub is null and d_sig is null and t_eph_pub is null and t_sig is null)),
  constraint term_views_from_fkey foreign key (from_node) references relay.nodes(id) on delete cascade,
  constraint term_views_to_fkey foreign key (to_node) references relay.nodes(id) on delete cascade
);
create index if not exists term_views_to_idx on relay.term_views (to_node, status);
create index if not exists term_views_from_idx on relay.term_views (from_node, created_at);
alter table relay.term_views enable row level security;
revoke all on relay.term_views from public, anon, authenticated;

create or replace function public.asn_relay_term_view_expire()
 returns void language plpgsql security definer set search_path to ''
as $function$
begin
  update relay.term_views
    set status = 'ended', end_reason = 'expired', ended_at = now(), topic = null, d_eph_pub = null, d_sig = null, t_eph_pub = null, t_sig = null
    where status <> 'ended' and expires_at <= now();
  delete from relay.term_views where status = 'ended' and ended_at < now() - interval '1 day';
end;
$function$;

-- D 發起（本人簽章）。回 topic 和 T 的門鈴
create or replace function public.asn_relay_term_view_start(p_actor text, p_signed_user uuid, p_id uuid, p_to_node text, p_window_name text, p_d_eph_pub text, p_d_sig text, p_expires_at timestamptz)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_topic text;
  v_bell text;
begin
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_id is null or p_to_node is null or p_to_node = p_actor
     or p_window_name is null or char_length(p_window_name) not between 1 and 64 or p_window_name ~ '[[:cntrl:]]'
     or p_d_eph_pub is null or p_d_eph_pub !~ '^[A-Za-z0-9_-]{43}$'
     or p_d_sig is null or p_d_sig !~ '^[A-Za-z0-9_-]+$' or char_length(p_d_sig) not between 86 and 700
     or p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '10 minutes 30 seconds' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not public.asn_user_owns_node(p_signed_user, p_to_node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  perform public.asn_relay_term_view_expire();
  if exists (select 1 from relay.term_views where id = p_id) then
    return jsonb_build_object('error', 'bad_request');   -- session id 不能重用
  end if;
  if exists (select 1 from relay.term_views where from_node = p_actor and to_node = p_to_node and window_name = p_window_name and status <> 'ended') then
    return jsonb_build_object('error', 'busy');
  end if;
  if (select count(*) from relay.term_views where to_node = p_to_node and status <> 'ended') >= 3 then
    return jsonb_build_object('error', 'busy');
  end if;
  if (select count(*) from relay.term_views where from_node = p_actor and created_at > now() - interval '1 hour') >= 30 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  select bell_topic into v_bell from relay.nodes where id = p_to_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  v_topic := 'tv_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into relay.term_views (id, from_node, to_node, window_name, topic, d_eph_pub, d_sig, expires_at)
    values (p_id, p_actor, p_to_node, p_window_name, v_topic, p_d_eph_pub, p_d_sig, p_expires_at);
  return jsonb_build_object('id', p_id, 'topic', v_topic, 'bell_topic', v_bell);
end;
$function$;

-- T 領取（節點金鑰）：要看我的請求，和我正在被看的狀態（viewer_stale＝D 太久沒回報，T 要自己停）
create or replace function public.asn_relay_term_view_pending(p_node text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_req jsonb;
  v_act jsonb;
begin
  perform public.asn_relay_term_view_expire();
  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'from_node', v.from_node, 'from_name', n.name, 'window_name', v.window_name, 'topic', v.topic,
      'd_eph_pub', v.d_eph_pub, 'd_sig', v.d_sig, 'expires_s', extract(epoch from v.expires_at)::bigint) order by v.created_at), '[]'::jsonb)
    into v_req
    from relay.term_views v join relay.nodes n on n.id = v.from_node
    where v.to_node = p_node and v.status = 'requested';
  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'status', v.status, 'viewer_stale', v.viewer_seen_at < now() - interval '90 seconds')), '[]'::jsonb)
    into v_act
    from relay.term_views v
    where v.to_node = p_node and v.status in ('accepted', 'watching', 'paused');
  return jsonb_build_object('requests', v_req, 'active', v_act);
end;
$function$;

-- T 接受（節點金鑰）：一次性公鑰和簽章。只有被看的那台能接受
create or replace function public.asn_relay_term_view_accept(p_node text, p_id uuid, p_t_eph_pub text, p_t_sig text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_n int;
begin
  if p_id is null or p_t_eph_pub is null or p_t_eph_pub !~ '^[A-Za-z0-9_-]{43}$' or p_t_sig is null or p_t_sig !~ '^[A-Za-z0-9_-]{86}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  perform public.asn_relay_term_view_expire();
  update relay.term_views set status = 'accepted', t_eph_pub = p_t_eph_pub, t_sig = p_t_sig, viewer_seen_at = now()
    where id = p_id and to_node = p_node and status = 'requested';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

-- T 結束或拒絕（節點金鑰）。原因只能是固定值
create or replace function public.asn_relay_term_view_stop(p_node text, p_id uuid, p_reason text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_n int;
begin
  if p_id is null or p_reason is null or p_reason not in ('target_ended', 'rejected', 'viewer_gone', 'failed') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.term_views
    set status = 'ended', end_reason = p_reason, ended_at = now(), topic = null, d_eph_pub = null, d_sig = null, t_eph_pub = null, t_sig = null
    where id = p_id and to_node = p_node and status <> 'ended';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

-- D 查狀態並回報（本人簽章）。p_state 只能是固定值；null＝只查。沒有其他欄位，所以沒有 D 傳內容給 T 的路
create or replace function public.asn_relay_term_view_report(p_actor text, p_signed_user uuid, p_id uuid, p_state text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare r relay.term_views%rowtype;
begin
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_id is null or (p_state is not null and p_state not in ('watching', 'paused', 'ended')) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  perform public.asn_relay_term_view_expire();
  select * into r from relay.term_views where id = p_id and from_node = p_actor for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if r.status <> 'ended' and p_state = 'ended' then
    update relay.term_views
      set status = 'ended', end_reason = 'viewer_ended', ended_at = now(), topic = null, d_eph_pub = null, d_sig = null, t_eph_pub = null, t_sig = null
      where id = r.id
      returning * into r;
  elsif r.status in ('accepted', 'watching', 'paused') and p_state in ('watching', 'paused') then
    update relay.term_views set status = p_state, viewer_seen_at = now() where id = r.id returning * into r;
  elsif r.status in ('accepted', 'watching', 'paused') and p_state is null then
    update relay.term_views set viewer_seen_at = now() where id = r.id returning * into r;
  end if;
  return jsonb_build_object('status', r.status, 'end_reason', r.end_reason, 't_eph_pub', r.t_eph_pub, 't_sig', r.t_sig, 'expires_s', extract(epoch from r.expires_at)::bigint);
end;
$function$;

revoke all on function public.asn_relay_term_view_expire() from public, anon, authenticated;
revoke all on function public.asn_relay_term_view_start(text, uuid, uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.asn_relay_term_view_pending(text) from public, anon, authenticated;
revoke all on function public.asn_relay_term_view_accept(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.asn_relay_term_view_stop(text, uuid, text) from public, anon, authenticated;
revoke all on function public.asn_relay_term_view_report(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.asn_relay_term_view_start(text, uuid, uuid, text, text, text, text, timestamptz) to service_role;
grant execute on function public.asn_relay_term_view_pending(text) to service_role;
grant execute on function public.asn_relay_term_view_accept(text, uuid, text, text) to service_role;
grant execute on function public.asn_relay_term_view_stop(text, uuid, text) to service_role;
grant execute on function public.asn_relay_term_view_report(text, uuid, uuid, text) to service_role;

commit;
