-- 手機確認終端送字／代答（#285、#439）：桌面要替使用者往終端送字、或回答終端的提問時，先建一筆請求，
-- 手機（本人簽章）看到預覽後按「確認」或「拒絕」，桌面領到「已確認」才執行，而且執行前仍照本機規則全部重驗。
-- 設計（與手機切換帳號 account_switches 同一套）：
--   * 只有桌面（節點金鑰）能「建立」請求；手機只能「決定」，不能改內容、不能自己建立。
--   * 內容綁雜湊：桌面算 SHA-256（送字＝完整文字＋是否換行；代答＝提問＋選項），手機決定時要原樣帶回。
--   * 一次性、2 分鐘過期；完成、拒絕、過期、取消後立刻清掉預覽與選項，雲端只留雜湊與狀態。
--   * 手機決定要本人簽章，而且請求的節點與發起的節點都是這個人的（asn_user_owns_node，和 #302 同一個檢查）。
--   * 頻率：每個節點每小時最多 20 筆；同一個節點同一個終端同時只有一筆未結案。
--   * 資料夾授權、接手窗格的寫入開關都不在這裡：手機確認不等於授權資料夾，也不能解鎖接手窗格（只認桌面本機）。
-- 先不用：舊版桌面不會呼叫這幾個動作，所以什麼都不會變。
-- 回復：drop 這五支函式與 relay.term_requests。
begin;

create table if not exists relay.term_requests (
  id uuid not null default gen_random_uuid(),
  tenant_id uuid not null,
  node text not null,
  kind text not null,
  term_id text not null,
  folder_label text not null default '',
  preview text,
  enter boolean not null default false,
  options jsonb,
  body_hash text not null,
  status text not null default 'pending',
  choice_n integer,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 minutes'),
  detail text,
  constraint term_requests_pkey primary key (id),
  constraint term_requests_kind_check check (kind = any (array['send','answer'])),
  constraint term_requests_term_id_check check (char_length(term_id) between 1 and 16 and term_id ~ '^[A-Za-z0-9_-]+$'),
  constraint term_requests_folder_check check (char_length(folder_label) <= 60),
  constraint term_requests_preview_check check (preview is null or char_length(preview) <= 200),
  constraint term_requests_hash_check check (body_hash ~ '^[0-9a-f]{64}$'),
  constraint term_requests_status_check check (status = any (array['pending','approved','denied','expired','taken','done','failed','cancelled'])),
  constraint term_requests_node_fkey foreign key (node) references relay.nodes(id),
  constraint term_requests_node_same_tenant foreign key (tenant_id, node) references relay.nodes(tenant_id, id)
);
create index if not exists term_requests_node_idx on relay.term_requests (node, created_at);
alter table relay.term_requests enable row level security;
revoke all on relay.term_requests from public, anon, authenticated;

-- 逾時的標成 expired 並清掉預覽與選項（每個函式開頭都呼叫）：pending／approved 超過 2 分鐘；taken 超過 10 分鐘還沒回報
create or replace function public.asn_relay_term_req_expire()
 returns void language sql security definer set search_path to ''
as $function$
  update relay.term_requests set status = 'expired', preview = null, options = null, detail = coalesce(detail, '逾時沒有處理')
    where (status in ('pending', 'approved') and expires_at <= now())
       or (status = 'taken' and expires_at <= now() - interval '8 minutes');
$function$;

-- 桌面建立請求（節點金鑰）
create or replace function public.asn_relay_term_req_create(p_node text, p_kind text, p_term_id text, p_folder_label text, p_preview text, p_enter boolean, p_options jsonb, p_hash text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_t uuid;
  v_topic text;
  v_id uuid;
  v_exp timestamptz;
  v_opts jsonb := null;
  v_o jsonb;
  v_prev text;
  v_label text;
begin
  select tenant_id, bell_topic into v_t, v_topic from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_kind is null or p_kind not in ('send', 'answer')
     or p_term_id is null or p_term_id !~ '^[A-Za-z0-9_-]{1,16}$'
     or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
     or p_preview is null or char_length(btrim(p_preview)) = 0 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  v_prev := left(regexp_replace(p_preview, '[[:cntrl:]]', ' ', 'g'), 200);
  v_label := left(regexp_replace(coalesce(p_folder_label, ''), '[[:cntrl:]]', ' ', 'g'), 60);
  if p_kind = 'answer' then
    if p_options is null or jsonb_typeof(p_options) <> 'array' or jsonb_array_length(p_options) < 1 or jsonb_array_length(p_options) > 12 then
      return jsonb_build_object('error', 'bad_request');
    end if;
    v_opts := '[]'::jsonb;
    for v_o in select * from jsonb_array_elements(p_options) loop
      if jsonb_typeof(v_o) is distinct from 'object' or jsonb_typeof(v_o->'n') is distinct from 'number' or (v_o->>'n') !~ '^[0-9]{1,2}$' or jsonb_typeof(v_o->'label') is distinct from 'string' then
        return jsonb_build_object('error', 'bad_request');
      end if;
      v_opts := v_opts || jsonb_build_array(jsonb_build_object('n', (v_o->>'n')::int, 'label', left(regexp_replace(v_o->>'label', '[[:cntrl:]]', ' ', 'g'), 60)));
    end loop;
  elsif p_options is not null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  perform public.asn_relay_term_req_expire();
  if exists (select 1 from relay.term_requests where node = p_node and term_id = p_term_id and status in ('pending', 'approved', 'taken')) then
    return jsonb_build_object('error', 'busy');
  end if;
  if (select count(*) from relay.term_requests where node = p_node and created_at > now() - interval '1 hour') >= 20 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.term_requests (tenant_id, node, kind, term_id, folder_label, preview, enter, options, body_hash)
    values (v_t, p_node, p_kind, p_term_id, v_label, v_prev, coalesce(p_enter, false), v_opts, p_hash)
    returning id, expires_at into v_id, v_exp;
  return jsonb_build_object('id', v_id, 'expires_at', v_exp, 'bell_topic', v_topic);
end;
$function$;

-- 手機（本人簽章）列出名下節點的待確認請求
create or replace function public.asn_relay_term_req_list(p_actor text, p_signed_user uuid)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_out jsonb;
begin
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  perform public.asn_relay_term_req_expire();
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'node', r.node, 'kind', r.kind, 'term_id', r.term_id, 'folder_label', r.folder_label, 'preview', r.preview,
      'enter', r.enter, 'options', r.options, 'body_hash', r.body_hash, 'expires_at', r.expires_at) order by r.created_at), '[]'::jsonb)
    into v_out
    from relay.term_requests r
    where r.status = 'pending' and r.expires_at > now() and public.asn_user_owns_node(p_signed_user, r.node);
  return jsonb_build_object('requests', v_out);
end;
$function$;

-- 手機決定：必須本人簽章、請求的節點是這個人的、雜湊相同、還沒過期；一次性
create or replace function public.asn_relay_term_req_decide(p_actor text, p_signed_user uuid, p_id uuid, p_decision text, p_choice_n integer, p_hash text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  r relay.term_requests%rowtype;
begin
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_decision is null or p_decision not in ('approve', 'deny') or p_id is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  perform public.asn_relay_term_req_expire();
  select * into r from relay.term_requests where id = p_id for update;
  if not found or r.status <> 'pending' or r.expires_at <= now() then
    return jsonb_build_object('error', 'not_found');
  end if;
  if not public.asn_user_owns_node(p_signed_user, r.node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_hash is distinct from r.body_hash then
    return jsonb_build_object('error', 'hash_mismatch');
  end if;
  if p_decision = 'deny' then
    update relay.term_requests set status = 'denied', decided_by = p_signed_user, decided_at = now(), preview = null, options = null where id = r.id;
    return jsonb_build_object('ok', true, 'status', 'denied');
  end if;
  if r.kind = 'answer' then
    if p_choice_n is null or not exists (select 1 from jsonb_array_elements(r.options) o where (o->>'n')::int = p_choice_n) then
      return jsonb_build_object('error', 'bad_choice');
    end if;
  elsif p_choice_n is not null then
    return jsonb_build_object('error', 'bad_choice');
  end if;
  update relay.term_requests set status = 'approved', choice_n = p_choice_n, decided_by = p_signed_user, decided_at = now() where id = r.id;
  return jsonb_build_object('ok', true, 'status', 'approved');
end;
$function$;

-- 桌面領取：領走已確認的（approved → taken）；另外回報最近被拒絕或過期的編號，讓桌面清掉本機暫存
create or replace function public.asn_relay_term_req_take(p_node text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_ok jsonb;
  v_closed jsonb;
begin
  perform public.asn_relay_term_req_expire();
  with t as (
    update relay.term_requests set status = 'taken' where node = p_node and status = 'approved' and expires_at > now()
      returning id, kind, term_id, choice_n, body_hash, enter, created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'term_id', t.term_id, 'choice_n', t.choice_n, 'body_hash', t.body_hash, 'enter', t.enter) order by t.created_at), '[]'::jsonb)
    into v_ok from t;
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'status', c.status)), '[]'::jsonb)
    into v_closed from relay.term_requests c
    where c.node = p_node and c.status in ('denied', 'expired') and c.created_at > now() - interval '10 minutes';
  return jsonb_build_object('requests', v_ok, 'closed', v_closed);
end;
$function$;

-- 桌面回報結果：done／failed／cancelled（本機先按了確認框就是 cancelled）；只動同節點、還沒結案的列；清掉預覽與選項
create or replace function public.asn_relay_term_req_result(p_node text, p_id uuid, p_status text, p_detail text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_n int;
begin
  if p_status is null or p_status not in ('done', 'failed', 'cancelled') or p_id is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.term_requests
    set status = p_status, detail = left(regexp_replace(coalesce(p_detail, ''), '[[:cntrl:]]', ' ', 'g'), 200), preview = null, options = null
    where id = p_id and node = p_node and status in ('pending', 'approved', 'taken');
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.asn_relay_term_req_expire() from public, anon, authenticated;
revoke all on function public.asn_relay_term_req_create(text, text, text, text, text, boolean, jsonb, text) from public, anon, authenticated;
revoke all on function public.asn_relay_term_req_list(text, uuid) from public, anon, authenticated;
revoke all on function public.asn_relay_term_req_decide(text, uuid, uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.asn_relay_term_req_take(text) from public, anon, authenticated;
revoke all on function public.asn_relay_term_req_result(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_term_req_create(text, text, text, text, text, boolean, jsonb, text) to service_role;
grant execute on function public.asn_relay_term_req_list(text, uuid) to service_role;
grant execute on function public.asn_relay_term_req_decide(text, uuid, uuid, text, integer, text) to service_role;
grant execute on function public.asn_relay_term_req_take(text) to service_role;
grant execute on function public.asn_relay_term_req_result(text, uuid, text, text) to service_role;

commit;
