-- 遠端管理夥伴視窗（詳情、改名、切換模型、關閉、轉交下一任、喚醒；設計見 docs/design/PARTNER-OPS.md）。
-- 手機下指令 → 這裡記一筆 partner_ops（pending）→ 敲那台電腦的門鈴 → 電腦端內建收發室取走（taken）→ 執行 → 回報（ok／failed／unconfirmed）。
-- 與「遠端開視窗」（relay.launches）同形：下令一律要本人簽章（p_signed_user，Edge Function 驗過登入憑證才傳進來），
-- 而且簽章的人要擁有「呼叫節點」與「目標節點」（asn_user_owns_node），兩台同租戶。
-- 不改任何既有資料表與函式。先不套用：部署順序為 migration → relay 函式 → 發新版 ASN（反過來也安全，見設計文件第五節）。
begin;

create table if not exists relay.partner_ops (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  requested_by text not null references relay.nodes(id),
  node text not null references relay.nodes(id),
  name text not null check (char_length(name) between 1 and 80),
  op text not null check (op in ('info', 'rename', 'model', 'close', 'handover', 'resume')),
  session_id text check (session_id is null or session_id ~ '^[A-Za-z0-9_-]{8,80}$'),
  new_name text check (new_name is null or char_length(new_name) between 1 and 40),
  model text check (model is null or char_length(model) between 1 and 60),
  note text check (note is null or char_length(note) between 1 and 1000),
  status text not null default 'pending' check (status in ('pending', 'taken', 'ok', 'failed', 'unconfirmed')),
  detail text check (detail is null or char_length(detail) <= 500),
  result jsonb check (result is null or octet_length(result::text) <= 4096),
  created_at timestamptz not null default now(),
  taken_at timestamptz,
  done_at timestamptz
);
create index if not exists partner_ops_node_idx on relay.partner_ops (node, created_at);
alter table relay.partner_ops enable row level security;
revoke all on relay.partner_ops from public, anon, authenticated;

-- 下令（手機，要本人簽章；沒簽章一律 forbidden）
create or replace function public.irori_relay_partner_op(
  p_actor text, p_signed_user uuid, p_node text, p_name text, p_op text, p_new_name text, p_model text, p_note text
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_t uuid;
  v_l jsonb;
  v_topic text;
  v_id uuid;
  v_sid text;
  v_engine text;
  v_online boolean;
begin
  if p_op is null or p_op not in ('info', 'rename', 'model', 'close', 'handover', 'resume')
     or p_name is null or char_length(p_name) not between 1 and 80 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if p_op = 'rename' and not public.irori_relay_launch_name_ok(p_new_name) then
    return jsonb_build_object('error', 'bad_name');
  end if;
  if p_op = 'model' and (p_model is null or p_model !~ '^[A-Za-z0-9._\[\]-]{1,60}$') then
    return jsonb_build_object('error', 'bad_model');
  end if;
  if p_op = 'handover' and p_note is not null and char_length(p_note) > 1000 then
    return jsonb_build_object('error', 'bad_note');
  end if;
  -- 呼叫節點與目標節點都要是簽章者的、同租戶
  select tenant_id into v_t from relay.nodes
    where id = p_actor and status = 'active' and public.asn_user_owns_node(p_signed_user, p_actor);
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select launcher, bell_topic into v_l, v_topic from relay.nodes
    where id = p_node and status = 'active' and tenant_id is not distinct from v_t
      and public.asn_user_owns_node(p_signed_user, p_node);
  if v_topic is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_op = 'resume' then
    -- 喚醒：目標視窗已經關了（不能在名單上），用夥伴記錄裡的 session 在原本的資料夾接回同一段對話
    if p_name ~ '收發室$' then
      return jsonb_build_object('error', 'protected');
    end if;
    if exists (select 1 from relay.roster where node = p_node and lower(name) = lower(p_name) and seen_at > now() - interval '3 minutes') then
      return jsonb_build_object('error', 'already_online');
    end if;
    -- 依「節點＋名字」找夥伴：目前的名字優先，其次 7 天內改掉的舊名（與寄信的解析同一套）
    select p.current_session, p.engine into v_sid, v_engine from relay.partners p
      where p.node = p_node and p.tenant_id is not distinct from v_t
        and (p.current_name = p_name
             or exists (select 1 from relay.partner_names pn where pn.partner_id = p.partner_id and pn.name = p_name and pn.renamed_at > now() - interval '7 days'))
      order by (p.current_name = p_name) desc, p.updated_at desc limit 1;
    if not found then
      return jsonb_build_object('error', 'not_found');
    end if;
    if v_engine is not null and v_engine <> 'claude' then
      return jsonb_build_object('error', 'not_claude');
    end if;
    if v_sid is null then
      return jsonb_build_object('error', 'no_session');
    end if;
    if v_l is null then
      return jsonb_build_object('error', 'no_launcher');
    end if;
    -- 那台電腦的 ASN 要在線（節點心跳或名單 3 分鐘內有回報），不然喚醒會卡到逾時
    select coalesce(n.last_seen_at > now() - interval '3 minutes', false)
           or exists (select 1 from relay.roster r where r.node = p_node and r.seen_at > now() - interval '3 minutes')
      into v_online from relay.nodes n where n.id = p_node;
    if not coalesce(v_online, false) then
      return jsonb_build_object('error', 'device_offline');
    end if;
  else
    -- 目標名字 3 分鐘內要在名單上
    if not exists (select 1 from relay.roster where node = p_node and name = p_name and seen_at > now() - interval '3 minutes') then
      return jsonb_build_object('error', 'not_found');
    end if;
    -- 收發室與 ASN 自己的視窗不能動（電腦端執行前還會再擋一次）
    if exists (select 1 from relay.roster where node = p_node and name = p_name and engine = 'asn') or p_name ~ '收發室$' then
      return jsonb_build_object('error', 'protected');
    end if;
    -- 詳情是唯讀，不需要開放；其餘要那台電腦打開「允許遠端開視窗與管理視窗」（launcher 不為 null）
    if p_op <> 'info' and v_l is null then
      return jsonb_build_object('error', 'no_launcher');
    end if;
  end if;
  if p_op = 'rename' then
    if exists (select 1 from relay.roster where node = p_node and lower(name) = lower(p_new_name) and seen_at > now() - interval '3 minutes')
       or exists (select 1 from relay.partner_ops where node = p_node and op = 'rename' and lower(new_name) = lower(p_new_name)
                  and (status in ('pending', 'taken') and created_at > now() - interval '10 minutes'
                       or status in ('ok', 'unconfirmed') and done_at > now() - interval '3 minutes')) then
      return jsonb_build_object('error', 'name_taken');
    end if;
  end if;
  if exists (select 1 from relay.partner_ops where node = p_node and lower(name) = lower(p_name)
             and status in ('pending', 'taken')
             -- 未完成的操作多久之內還算「進行中」：接班換手最長會跑到 15 分鐘，所以放寬到 20 分鐘；其他動作 10 分鐘
             and created_at > now() - case when op = 'handover' then interval '20 minutes' else interval '10 minutes' end) then
    return jsonb_build_object('error', 'busy');
  end if;
  if (select count(*) from relay.partner_ops where node = p_node and created_at > now() - interval '1 hour') >= 30 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.partner_ops (tenant_id, requested_by, node, name, op, session_id, new_name, model, note)
    values (v_t, p_actor, p_node, p_name, p_op,
            case when p_op = 'resume' then v_sid end,
            case when p_op = 'rename' then p_new_name end,
            case when p_op = 'model' then p_model end,
            case when p_op = 'handover' then nullif(p_note, '') end)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'bell_topic', v_topic);
end;
$function$;

-- 查進度（手機，要本人簽章）：只回自己租戶的；2 分鐘沒被取走的顯示成失敗（逾時）
create or replace function public.irori_relay_partner_ops(p_actor text, p_signed_user uuid, p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_t uuid; v_out jsonb;
begin
  select tenant_id into v_t from relay.nodes
    where id = p_actor and status = 'active' and public.asn_user_owns_node(p_signed_user, p_actor);
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'node', o.node, 'name', o.name, 'op', o.op,
      'status', case when o.status = 'pending' and o.created_at <= now() - interval '2 minutes' then 'failed' else o.status end,
      'detail', case when o.status = 'pending' and o.created_at <= now() - interval '2 minutes' then 'expired' else o.detail end,
      'result', o.result, 'created_at', o.created_at, 'done_at', o.done_at) order by o.created_at desc), '[]'::jsonb)
    into v_out from (
      select * from relay.partner_ops
      where tenant_id is not distinct from v_t and id = any(p_ids)
      order by created_at desc limit 20
    ) o;
  return jsonb_build_object('ops', v_out);
end;
$function$;

-- 電腦端取走自己節點的待辦；超過 2 分鐘還沒取走的標失敗（避免電腦開機後突然補做一堆）
create or replace function public.irori_relay_partner_op_pending(p_node text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_out jsonb;
begin
  update relay.partner_ops set status = 'failed', detail = 'expired', done_at = now()
    where node = p_node and status = 'pending' and created_at <= now() - interval '2 minutes';
  with t as (
    update relay.partner_ops set status = 'taken', taken_at = now()
      where node = p_node and status = 'pending'
      returning id, name, op, session_id, new_name, model, note, requested_by, created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'name', t.name, 'op', t.op, 'session_id', t.session_id, 'new_name', t.new_name, 'model', t.model, 'note', t.note,
      'requested_by', t.requested_by,
      'requested_by_label', (select n.name from relay.nodes n where n.id = t.requested_by),
      'created_at', t.created_at) order by t.created_at), '[]'::jsonb)
    into v_out from t;
  return v_out;
end;
$function$;

-- 電腦端回報結果（只能改自己節點、已取走的那筆；result 最多 4 KB）
create or replace function public.irori_relay_partner_op_result(p_node text, p_id uuid, p_status text, p_detail text, p_result jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_n int;
begin
  if p_status is null or p_status not in ('ok', 'failed', 'unconfirmed')
     or (p_result is not null and octet_length(p_result::text) > 4096) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.partner_ops set status = p_status, detail = left(p_detail, 500), result = p_result, done_at = now()
    where id = p_id and node = p_node and status = 'taken';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

-- 電腦端中途回報階段（只改自己節點、處理中那筆的 detail；狀態不變）
create or replace function public.irori_relay_partner_op_progress(p_node text, p_id uuid, p_detail text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_n int;
begin
  if p_detail is null or p_detail !~ '^stage:[a-z]{1,20}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.partner_ops set detail = p_detail where id = p_id and node = p_node and status = 'taken';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.irori_relay_partner_op(text, uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.irori_relay_partner_op(text, uuid, text, text, text, text, text, text) to service_role;
revoke all on function public.irori_relay_partner_ops(text, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.irori_relay_partner_ops(text, uuid, uuid[]) to service_role;
revoke all on function public.irori_relay_partner_op_pending(text) from public, anon, authenticated;
grant execute on function public.irori_relay_partner_op_pending(text) to service_role;
revoke all on function public.irori_relay_partner_op_result(text, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.irori_relay_partner_op_result(text, uuid, text, text, jsonb) to service_role;

revoke all on function public.irori_relay_partner_op_progress(text, uuid, text) from public, anon, authenticated;
grant execute on function public.irori_relay_partner_op_progress(text, uuid, text) to service_role;

commit;
