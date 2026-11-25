-- #1908：換班接手在等前任的子代理做完，可能等很久；本人按「關閉視窗」要能放行（卡死時的出口）。
-- 原本 asn_relay_partner_op 的「忙碌」規則在同一個視窗有 pending／taken 的換班（20 分鐘內）時，一律擋掉新的操作，連 close 也擋，
-- 所以「關閉視窗」在換班開始後的前 20 分鐘過不了後台，只有電腦端放行也沒用。
-- 這版只改這一處：上一筆是換班（handover）時，新的 close 不算忙碌。其他動作的忙碌規則、其他所有檢查一字不改。
--   · 上一筆是換班、新的是 close：放行
--   · 上一筆是換班、新的是 info／rename／model／handover／resume／restart／remove：照舊 busy
--   · 上一筆是 close（或其他動作）、新的又是 close：照舊 busy
-- 函式本體照 20261123120000_online_window.sql 的 asn_relay_partner_op 原樣，只在忙碌那段多一行。簽章、security definer、search_path、權限都和上一版相同。
-- 部署順序：先本 migration，再發新版 ASN（電腦端收到換班進行中的 close 會讓等待收手並回報失敗）。舊電腦端：照舊放行 close（本來就有 close_allowed_during_handoff）。
-- 回復：supabase/sql/rollback/20261125410000_partner_op_close_during_handover_down.sql
begin;

create or replace function public.asn_relay_partner_op(p_actor text, p_signed_user uuid, p_node text, p_name text, p_op text, p_new_name text, p_model text, p_note text)
 returns jsonb
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
  if p_op is null or p_op not in ('info', 'rename', 'model', 'close', 'handover', 'resume', 'restart', 'remove')
     or p_name is null or char_length(p_name) not between 1 and 80 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if p_op = 'rename' and not public.asn_relay_launch_name_ok(p_new_name) then
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
    if exists (select 1 from relay.roster where node = p_node and lower(name) = lower(p_name) and seen_at > now() - relay.online_window()) then
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
    if v_engine is not null and v_engine not in ('claude', 'pi') then
      return jsonb_build_object('error', 'not_claude');
    end if;
    if v_sid is null then
      return jsonb_build_object('error', 'no_session');
    end if;
    if v_l is null then
      return jsonb_build_object('error', 'no_launcher');
    end if;
    -- 那台電腦的 ASN 要在線（節點心跳或名單 3 分鐘內有回報），不然喚醒會卡到逾時
    select coalesce(n.last_seen_at > now() - relay.online_window(), false)
           or exists (select 1 from relay.roster r where r.node = p_node and r.seen_at > now() - relay.online_window())
      into v_online from relay.nodes n where n.id = p_node;
    if not coalesce(v_online, false) then
      return jsonb_build_object('error', 'device_offline');
    end if;
  else
    -- 目標名字 3 分鐘內要在名單上
    if not exists (select 1 from relay.roster where node = p_node and name = p_name and seen_at > now() - relay.online_window()) then
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
    if exists (select 1 from relay.roster where node = p_node and lower(name) = lower(p_new_name) and seen_at > now() - relay.online_window())
       or exists (select 1 from relay.partner_ops where node = p_node and op = 'rename' and lower(new_name) = lower(p_new_name)
                  and (status in ('pending', 'taken') and created_at > now() - interval '10 minutes'
                       or status in ('ok', 'unconfirmed') and done_at > now() - interval '3 minutes')) then
      return jsonb_build_object('error', 'name_taken');
    end if;
  end if;
  if exists (select 1 from relay.partner_ops where node = p_node and lower(name) = lower(p_name)
             and status in ('pending', 'taken')
             -- #1908：換班進行中，本人按「關閉視窗」要能放行（卡死的出口）；只放行 close，其他動作照舊
             and not (p_op = 'close' and op = 'handover')
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
revoke all on function public.asn_relay_partner_op(text, uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_partner_op(text, uuid, text, text, text, text, text, text) to service_role;

commit;
