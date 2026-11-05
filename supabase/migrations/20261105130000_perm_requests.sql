-- 手機回答 Claude 夥伴的權限框（#853，0.2.6）：電腦的讀畫面發現權限框，建一筆請求；手機（本人簽章）看到全文和選項，
-- 按一個；電腦領到後全部重查，才送那個選項的數字鍵。
-- 設計（流程和 term_requests 相同，另開一張表，舊版手機不會列出看不懂的東西）：
--   * 只有電腦（節點金鑰）能建立；手機只能選，不能改內容、不能自己建立。
--   * 只存權限框的文字和選項，不是畫面。沒有任何欄位能放要送的文字：手機只回選項數字，後台比對要在選項裡。
--   * 內容綁雜湊：電腦算 SHA-256（全文＋選項），手機決定時原樣帶回。電腦送鍵前還會用當下的畫面再算一次。
--   * 一次性、10 分鐘過期。手機決定、取消、過期就清掉全文和選項，只留雜湊、狀態、時間。
--   * 手機決定要本人簽章，而且請求的節點與發起的節點都是這個人的（asn_user_owns_node）。
--   * 頻率：同一個節點同一扇視窗同時只有一筆未結案；每個節點每小時最多 60 筆（框還在就重發，每框最多 6 次）。
-- 先不用：舊版電腦、手機不會呼叫這幾個動作，什麼都不會變。
-- 回復：drop 這五支函式與 relay.perm_requests。
begin;

create table if not exists relay.perm_requests (
  id uuid not null default gen_random_uuid(),
  tenant_id uuid not null,
  node text not null,
  window_name text not null,
  prompt_text text,
  complete boolean not null default false,
  options jsonb,
  body_hash text not null,
  status text not null default 'pending',
  choice_n integer,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  detail text,
  constraint perm_requests_pkey primary key (id),
  constraint perm_requests_window_check check (char_length(window_name) between 1 and 64),
  constraint perm_requests_text_check check (prompt_text is null or char_length(prompt_text) <= 16000),
  constraint perm_requests_hash_check check (body_hash ~ '^[0-9a-f]{64}$'),
  constraint perm_requests_choice_check check (choice_n is null or choice_n between 1 and 9),
  constraint perm_requests_status_check check (status = any (array['pending','decided','taken','done','failed','cancelled','expired'])),
  -- 結案後不留內容
  constraint perm_requests_no_text_after_pending check (status = 'pending' or (prompt_text is null and options is null)),
  constraint perm_requests_node_fkey foreign key (node) references relay.nodes(id),
  constraint perm_requests_node_same_tenant foreign key (tenant_id, node) references relay.nodes(tenant_id, id)
);
create index if not exists perm_requests_node_idx on relay.perm_requests (node, created_at);
alter table relay.perm_requests enable row level security;
revoke all on relay.perm_requests from public, anon, authenticated;

-- 逾時的標成 expired 並清掉內容（每個函式開頭都呼叫）；結案超過一天的刪掉
create or replace function public.asn_relay_perm_req_expire()
 returns void language plpgsql security definer set search_path to ''
as $function$
begin
  update relay.perm_requests set status = 'expired', prompt_text = null, options = null, detail = coalesce(detail, '逾時沒有處理')
    where status in ('pending', 'decided', 'taken') and expires_at <= now();
  delete from relay.perm_requests where created_at < now() - interval '1 day';
end;
$function$;

-- 電腦建立請求（節點金鑰）
create or replace function public.asn_relay_perm_req_create(p_node text, p_window_name text, p_prompt_text text, p_complete boolean, p_options jsonb, p_hash text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_t uuid;
  v_owner uuid;
  v_topics jsonb;
  v_id uuid;
  v_exp timestamptz;
  v_opts jsonb := '[]'::jsonb;
  v_o jsonb;
begin
  select tenant_id, owner_user into v_t, v_owner from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_window_name is null or char_length(p_window_name) not between 1 and 64 or p_window_name ~ '[[:cntrl:]]'
     or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
     or p_prompt_text is null or char_length(btrim(p_prompt_text)) = 0 or char_length(p_prompt_text) > 16000
     or p_options is null or jsonb_typeof(p_options) <> 'array' or jsonb_array_length(p_options) not between 1 and 9 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  for v_o in select * from jsonb_array_elements(p_options) loop
    if jsonb_typeof(v_o) is distinct from 'object' or jsonb_typeof(v_o->'n') is distinct from 'number' or (v_o->>'n') !~ '^[1-9]$'
       or jsonb_typeof(v_o->'label') is distinct from 'string' or char_length(btrim(v_o->>'label')) = 0 then
      return jsonb_build_object('error', 'bad_request');
    end if;
    v_opts := v_opts || jsonb_build_array(jsonb_build_object('n', (v_o->>'n')::int, 'label', left(regexp_replace(v_o->>'label', '[[:cntrl:]]', ' ', 'g'), 200)));
  end loop;
  perform public.asn_relay_perm_req_expire();
  if exists (select 1 from relay.perm_requests where node = p_node and window_name = p_window_name and status in ('pending', 'decided', 'taken')) then
    return jsonb_build_object('error', 'busy');
  end if;
  if (select count(*) from relay.perm_requests where node = p_node and created_at > now() - interval '1 hour') >= 60 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.perm_requests (tenant_id, node, window_name, prompt_text, complete, options, body_hash)
    values (v_t, p_node, p_window_name, p_prompt_text, coalesce(p_complete, false), v_opts, p_hash)
    returning id, expires_at into v_id, v_exp;
  -- 敲本人其他設備的門鈴（手機開著就馬上跳；門鈴沒有內容）
  select coalesce(jsonb_agg(n.bell_topic), '[]'::jsonb) into v_topics
    from relay.nodes n where n.owner_user = v_owner and n.status = 'active' and n.id <> p_node and n.bell_topic is not null;
  return jsonb_build_object('id', v_id, 'expires_at', v_exp, 'bell_topics', v_topics);
end;
$function$;

-- 手機（本人簽章）列出名下節點的權限框，另外回最近的結果（沒有內容），讓手機顯示有沒有送出
create or replace function public.asn_relay_perm_req_list(p_actor text, p_signed_user uuid)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_out jsonb;
  v_recent jsonb;
begin
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  perform public.asn_relay_perm_req_expire();
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'node', r.node, 'window_name', r.window_name, 'prompt_text', r.prompt_text, 'complete', r.complete,
      'options', r.options, 'body_hash', r.body_hash, 'expires_at', r.expires_at) order by r.created_at), '[]'::jsonb)
    into v_out
    from relay.perm_requests r
    where r.status = 'pending' and r.expires_at > now() and public.asn_user_owns_node(p_signed_user, r.node);
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'detail', r.detail)), '[]'::jsonb)
    into v_recent
    from relay.perm_requests r
    where r.decided_by = p_signed_user and r.decided_at > now() - interval '5 minutes';
  return jsonb_build_object('requests', v_out, 'recent', v_recent);
end;
$function$;

-- 手機決定：必須本人簽章、請求的節點是這個人的、雜湊相同、數字在選項裡、還沒過期；第一個決定為準
create or replace function public.asn_relay_perm_req_decide(p_actor text, p_signed_user uuid, p_id uuid, p_choice_n integer, p_hash text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  r relay.perm_requests%rowtype;
begin
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_id is null or p_choice_n is null or p_choice_n not between 1 and 9 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  perform public.asn_relay_perm_req_expire();
  select * into r from relay.perm_requests where id = p_id for update;
  if not found or r.status <> 'pending' or r.expires_at <= now() then
    return jsonb_build_object('error', 'not_found');
  end if;
  if not public.asn_user_owns_node(p_signed_user, r.node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_hash is distinct from r.body_hash then
    return jsonb_build_object('error', 'hash_mismatch');
  end if;
  if not exists (select 1 from jsonb_array_elements(r.options) o where (o->>'n')::int = p_choice_n) then
    return jsonb_build_object('error', 'bad_choice');
  end if;
  update relay.perm_requests set status = 'decided', choice_n = p_choice_n, decided_by = p_signed_user, decided_at = now(), prompt_text = null, options = null where id = r.id;
  return jsonb_build_object('ok', true, 'status', 'decided');
end;
$function$;

-- 電腦領取：領走已決定的（decided → taken）；另外回報這台最近過期的編號，讓電腦判斷要不要重發
create or replace function public.asn_relay_perm_req_take(p_node text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_ok jsonb;
  v_closed jsonb;
begin
  perform public.asn_relay_perm_req_expire();
  with t as (
    update relay.perm_requests set status = 'taken' where node = p_node and status = 'decided' and expires_at > now()
      returning id, window_name, choice_n, body_hash, created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'window_name', t.window_name, 'choice_n', t.choice_n, 'body_hash', t.body_hash) order by t.created_at), '[]'::jsonb)
    into v_ok from t;
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'status', c.status)), '[]'::jsonb)
    into v_closed from relay.perm_requests c
    where c.node = p_node and c.status = 'expired' and c.created_at > now() - interval '30 minutes';
  return jsonb_build_object('requests', v_ok, 'closed', v_closed);
end;
$function$;

-- 電腦回報結果：done／failed／cancelled（框不見了、本機先答了就是 cancelled）；只動同節點、還沒結案的列
create or replace function public.asn_relay_perm_req_result(p_node text, p_id uuid, p_status text, p_detail text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_n int;
begin
  if p_status is null or p_status not in ('done', 'failed', 'cancelled') or p_id is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.perm_requests
    set status = p_status, detail = left(regexp_replace(coalesce(p_detail, ''), '[[:cntrl:]]', ' ', 'g'), 200), prompt_text = null, options = null
    where id = p_id and node = p_node and status in ('pending', 'decided', 'taken');
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.asn_relay_perm_req_expire() from public, anon, authenticated;
revoke all on function public.asn_relay_perm_req_create(text, text, text, boolean, jsonb, text) from public, anon, authenticated;
revoke all on function public.asn_relay_perm_req_list(text, uuid) from public, anon, authenticated;
revoke all on function public.asn_relay_perm_req_decide(text, uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.asn_relay_perm_req_take(text) from public, anon, authenticated;
revoke all on function public.asn_relay_perm_req_result(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_perm_req_create(text, text, text, boolean, jsonb, text) to service_role;
grant execute on function public.asn_relay_perm_req_list(text, uuid) to service_role;
grant execute on function public.asn_relay_perm_req_decide(text, uuid, uuid, integer, text) to service_role;
grant execute on function public.asn_relay_perm_req_take(text) to service_role;
grant execute on function public.asn_relay_perm_req_result(text, uuid, text, text) to service_role;

commit;
