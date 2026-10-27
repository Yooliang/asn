-- 遠端管理夥伴：新增動作「移除」（remove，0.2 B3）。給收發室自己跑的背景工作者（從「開新夥伴」或接手開出來的 ACP 工作者）用：
-- 結束該工作者的程序、從名冊與記下的模型刪掉；工作資料夾的檔案留著。寫在 agents.json 的由電腦端拒絕（請到電腦上改設定檔）。
-- 檢查與「關閉」「重開」同一套（名字 3 分鐘內在名單上、開放遠端管理、保護名單、忙碌、每小時上限）。
-- 只擴大允許的動作清單，不改舊值：資料表的檢查條件與下令函式（asn_relay_partner_op）。函式本體照 20261023100000 原樣，只在動作清單加 remove。
-- create or replace 不動權限；部署順序為 migration → relay 函式 → 發新版 ASN（舊電腦端收到不認得的動作會回報失敗，不會出事）。
begin;

alter table relay.partner_ops drop constraint if exists partner_ops_op_check;
alter table relay.partner_ops add constraint partner_ops_op_check
  check (op in ('info', 'rename', 'model', 'close', 'handover', 'resume', 'restart', 'remove'));

create or replace function public.asn_relay_partner_op(
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

commit;
