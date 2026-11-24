-- #1863 後台：手機要核對某台電腦的指紋時，送一個「請電腦顯示指紋」請求（fp_show）。
-- 流程：手機（本人簽章）建立請求 → 後台敲該電腦的門鈴（kind=fp_show）→ 電腦（節點金鑰）領取、顯示視窗後回報「已顯示」
--       （或在電腦上按取消，回報「電腦端取消」）→ 手機查狀態，看到已顯示就換畫面 → 核對完成或手機取消時手機呼叫結束，後台再敲一次門鈴，電腦收起視窗。
-- 設計（流程與 perm_requests 同型，另開一張表，舊版電腦、手機不會呼叫這幾個函式，什麼都不會變）：
--   * 這張表只存「誰要看哪一台、狀態、時間」。指紋與 QR 內容由電腦在本機產生，後台不經手、不存，表裡沒有任何欄位能放它們。
--   * 只有本人簽章能建立與結束：呼叫的手機節點與目標電腦都必須是這個人的（asn_user_owns_node），別人一律 forbidden。
--   * 電腦只能領取與回報發給自己的請求（以節點金鑰認出的節點為準，不收別台的編號）。
--   * 每台電腦同時只留一筆還活著的請求（pending／shown）：新請求會把舊的標成 superseded；同一台 10 秒內不能再請求（rate_limited）。
--   * 5 分鐘後自動視為過期（查詢與每個函式開頭順便判定），結案超過一天的列刪掉。
--   * 狀態：pending（等電腦顯示）、shown（電腦已顯示）、pc_cancelled（電腦端取消）、ended（手機結束）、superseded（被新請求取代）、expired（逾時）。
-- 回復：supabase/sql/rollback/20261125320000_fp_show_requests_down.sql（drop 這六支函式與 relay.fp_show_requests）。
begin;

create table if not exists relay.fp_show_requests (
  id uuid not null default gen_random_uuid(),
  tenant_id uuid not null,
  node text not null,
  requested_by uuid not null,
  requester_node text not null,
  status text not null default 'pending',
  detail text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  shown_at timestamptz,
  ended_at timestamptz,
  constraint fp_show_requests_pkey primary key (id),
  constraint fp_show_requests_status_check check (status = any (array['pending','shown','pc_cancelled','ended','superseded','expired'])),
  constraint fp_show_requests_node_fkey foreign key (node) references relay.nodes(id),
  constraint fp_show_requests_node_same_tenant foreign key (tenant_id, node) references relay.nodes(tenant_id, id)
);
create index if not exists fp_show_requests_node_idx on relay.fp_show_requests (node, created_at);
-- 每台電腦同時只有一筆活著的請求（資料庫層保證，不只靠函式）
create unique index if not exists fp_show_requests_one_live on relay.fp_show_requests (node) where status in ('pending', 'shown');
alter table relay.fp_show_requests enable row level security;
revoke all on relay.fp_show_requests from public, anon, authenticated;

-- 逾時的標成 expired（每個函式開頭都呼叫）；結案超過一天的刪掉
create or replace function public.asn_relay_fp_show_expire()
 returns void language plpgsql security definer set search_path to ''
as $function$
begin
  update relay.fp_show_requests set status = 'expired', ended_at = now(), detail = coalesce(detail, '逾時沒有處理')
    where status in ('pending', 'shown') and expires_at <= now();
  delete from relay.fp_show_requests where created_at < now() - interval '1 day';
end;
$function$;

-- 手機（本人簽章）請電腦顯示指紋。回傳請求編號、到期時間，以及目標電腦的門鈴頻道（只給 Edge 敲門鈴用，Edge 不會回給客戶端）
create or replace function public.asn_relay_fp_show_request(p_actor text, p_signed_user uuid, p_target text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_t uuid;
  v_topic text;
  v_id uuid;
  v_exp timestamptz;
begin
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_target is null or char_length(p_target) = 0 or p_target = p_actor then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not public.asn_user_owns_node(p_signed_user, p_target) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  perform public.asn_relay_fp_show_expire();
  select tenant_id, bell_topic into v_t, v_topic from relay.nodes where id = p_target and status = 'active';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  -- 同一台電腦 10 秒內不能重複請求（含已被取代、已結案的）
  if exists (select 1 from relay.fp_show_requests where node = p_target and created_at > now() - interval '10 seconds') then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  -- 每台同時只留一筆：舊的活請求被新的取代
  update relay.fp_show_requests set status = 'superseded', ended_at = now(), detail = '被新的請求取代'
    where node = p_target and status in ('pending', 'shown');
  insert into relay.fp_show_requests (tenant_id, node, requested_by, requester_node)
    values (v_t, p_target, p_signed_user, p_actor)
    returning id, expires_at into v_id, v_exp;
  return jsonb_build_object('id', v_id, 'expires_at', v_exp, 'bell_topic', v_topic);
end;
$function$;

-- 電腦領取發給自己的請求：回還活著的（pending／shown）與最近 5 分鐘內被結束的（讓電腦知道要收視窗）。不改狀態，可重複呼叫
create or replace function public.asn_relay_fp_show_take(p_node text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_live jsonb;
  v_closed jsonb;
begin
  perform public.asn_relay_fp_show_expire();
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'expires_at', r.expires_at) order by r.created_at), '[]'::jsonb)
    into v_live from relay.fp_show_requests r where r.node = p_node and r.status in ('pending', 'shown');
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'status', c.status) order by c.created_at), '[]'::jsonb)
    into v_closed from relay.fp_show_requests c
    where c.node = p_node and c.status in ('ended', 'superseded', 'expired') and c.ended_at > now() - interval '5 minutes';
  return jsonb_build_object('requests', v_live, 'closed', v_closed);
end;
$function$;

-- 電腦回報：shown（視窗已顯示）或 cancelled（在電腦上按了取消）。只動自己節點、還活著的列
create or replace function public.asn_relay_fp_show_ack(p_node text, p_id uuid, p_status text, p_detail text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_n int;
begin
  if p_id is null or p_status is null or p_status not in ('shown', 'cancelled') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  perform public.asn_relay_fp_show_expire();
  if p_status = 'shown' then
    update relay.fp_show_requests set status = 'shown', shown_at = now()
      where id = p_id and node = p_node and status = 'pending';
  else
    update relay.fp_show_requests
      set status = 'pc_cancelled', ended_at = now(), detail = left(regexp_replace(coalesce(p_detail, ''), '[[:cntrl:]]', ' ', 'g'), 200)
      where id = p_id and node = p_node and status in ('pending', 'shown');
  end if;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

-- 手機（本人簽章）查請求狀態：只看得到自己發的、且名下的電腦
create or replace function public.asn_relay_fp_show_status(p_actor text, p_signed_user uuid, p_id uuid)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  r relay.fp_show_requests%rowtype;
begin
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_id is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  perform public.asn_relay_fp_show_expire();
  select * into r from relay.fp_show_requests where id = p_id;
  if not found or r.requested_by <> p_signed_user then
    return jsonb_build_object('error', 'not_found');
  end if;
  if not public.asn_user_owns_node(p_signed_user, r.node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  return jsonb_build_object('id', r.id, 'status', r.status, 'detail', r.detail, 'expires_at', r.expires_at);
end;
$function$;

-- 手機（本人簽章）結束：核對完成或手機取消。活著的標成 ended 並回該電腦的門鈴頻道（Edge 再敲一次讓電腦收視窗）；已結案的回 ok、不再敲
create or replace function public.asn_relay_fp_show_end(p_actor text, p_signed_user uuid, p_id uuid)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  r relay.fp_show_requests%rowtype;
  v_topic text;
begin
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_id is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  perform public.asn_relay_fp_show_expire();
  select * into r from relay.fp_show_requests where id = p_id for update;
  if not found or r.requested_by <> p_signed_user then
    return jsonb_build_object('error', 'not_found');
  end if;
  if not public.asn_user_owns_node(p_signed_user, r.node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if r.status not in ('pending', 'shown') then
    return jsonb_build_object('ok', true, 'status', r.status);
  end if;
  update relay.fp_show_requests set status = 'ended', ended_at = now() where id = r.id;
  select n.bell_topic into v_topic from relay.nodes n where n.id = r.node;
  return jsonb_build_object('ok', true, 'status', 'ended', 'bell_topic', v_topic);
end;
$function$;

revoke all on function public.asn_relay_fp_show_expire() from public, anon, authenticated;
revoke all on function public.asn_relay_fp_show_request(text, uuid, text) from public, anon, authenticated;
revoke all on function public.asn_relay_fp_show_take(text) from public, anon, authenticated;
revoke all on function public.asn_relay_fp_show_ack(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.asn_relay_fp_show_status(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.asn_relay_fp_show_end(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_fp_show_request(text, uuid, text) to service_role;
grant execute on function public.asn_relay_fp_show_take(text) to service_role;
grant execute on function public.asn_relay_fp_show_ack(text, uuid, text, text) to service_role;
grant execute on function public.asn_relay_fp_show_status(text, uuid, uuid) to service_role;
grant execute on function public.asn_relay_fp_show_end(text, uuid, uuid) to service_role;

commit;
