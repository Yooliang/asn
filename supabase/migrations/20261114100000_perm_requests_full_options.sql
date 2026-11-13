-- #1445（0.2.21）：手機確認框照原本的選項顯示，另外加危險指令提示。設計稿在 asn-security 的 design-1445-phone-perm-danger.md。
-- 在 relay.perm_requests 加三欄，都由電腦端（節點金鑰）算好送來：
--   * options_full：權限框的完整原始選項 [{n, label, kind}]。n 是畫面上的數字鍵（和 options 同一套編號），kind 只認
--     allow_once／allow_always／deny／other，其他一律當 other。舊的 options（舊手機用）的編號要是 options_full 的子集。
--   * risk：{codes: [...], uncertain: bool}。代碼只收白名單；**不認得的代碼丟掉，這一筆標 uncertain 照常收下**（asn真 拍板：
--     以後新增代碼時，舊後台只會讓手機多一層小心，不會讓確認框送不到）。最多 8 個。
--   * full_len：截斷前的字數，只給手機顯示。
-- 手機決定時，數字在 options 或 options_full 裡都算（新手機按的是完整選項）。結案時 options_full、risk 和全文一起清掉。
-- 相容：舊電腦、舊 relay 照舊呼叫六個參數的建立函式，新欄位是空的；舊手機照舊只看 options。
-- 上線順序：這支 migration 先，relay（edge function）次，電腦版最後。
-- 回復：drop 九個參數的建立函式、拿掉三欄（另外把下面重寫的四支函式換回 20261105130000 的版本）。
begin;

alter table relay.perm_requests add column if not exists options_full jsonb;
alter table relay.perm_requests add column if not exists risk jsonb;
alter table relay.perm_requests add column if not exists full_len integer;
alter table relay.perm_requests drop constraint if exists perm_requests_full_len_check;
alter table relay.perm_requests add constraint perm_requests_full_len_check check (full_len is null or full_len between 0 and 10000000);
-- 結案後不留內容：完整選項（字是畫面上的）與危險代碼也一起清
alter table relay.perm_requests drop constraint if exists perm_requests_no_text_after_pending;
alter table relay.perm_requests add constraint perm_requests_no_text_after_pending
  check (status = 'pending' or (prompt_text is null and options is null and options_full is null and risk is null));

-- 逾時的標成 expired 並清掉內容（每個函式開頭都呼叫）；結案超過一天的刪掉
create or replace function public.asn_relay_perm_req_expire()
 returns void language plpgsql security definer set search_path to ''
as $function$
begin
  update relay.perm_requests set status = 'expired', prompt_text = null, options = null, options_full = null, risk = null, detail = coalesce(detail, '逾時沒有處理')
    where status in ('pending', 'decided', 'taken') and expires_at <= now();
  delete from relay.perm_requests where created_at < now() - interval '1 day';
end;
$function$;

-- 電腦建立請求（節點金鑰），新版：多三個參數。p_options_full 是 null 就是舊格式（其他框、舊電腦）
create or replace function public.asn_relay_perm_req_create(p_node text, p_window_name text, p_prompt_text text, p_complete boolean, p_options jsonb, p_hash text,
  p_options_full jsonb, p_risk jsonb, p_full_len integer)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_t uuid;
  v_owner uuid;
  v_topics jsonb;
  v_id uuid;
  v_exp timestamptz;
  v_opts jsonb := '[]'::jsonb;
  v_full jsonb := null;
  v_risk jsonb := null;
  v_codes jsonb := '[]'::jsonb;
  v_uncertain boolean := false;
  v_seen int[] := '{}';
  v_o jsonb;
  v_c jsonb;
  v_kind text;
  c_known constant text[] := array['delete_recursive','git_destructive','disk_system','remote_exec','secret_path','privilege','db_destructive','outside_cwd'];
begin
  -- relay 舊格式（其他框、舊電腦）會把 null 傳成 JSON 的 null：當成沒帶，不能回 bad_request（asn真 審查必修 3）
  if jsonb_typeof(p_options_full) = 'null' then
    p_options_full := null;
  end if;
  if jsonb_typeof(p_risk) = 'null' then
    p_risk := null;
  end if;
  select tenant_id, owner_user into v_t, v_owner from relay.nodes where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_window_name is null or char_length(p_window_name) not between 1 and 64 or p_window_name ~ '[[:cntrl:]]'
     or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
     or p_prompt_text is null or char_length(btrim(p_prompt_text)) = 0 or char_length(p_prompt_text) > 16000
     or p_options is null or jsonb_typeof(p_options) <> 'array' or jsonb_array_length(p_options) > 9
     or (p_full_len is not null and p_full_len not between 0 and 10000000) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  for v_o in select * from jsonb_array_elements(p_options) loop
    if jsonb_typeof(v_o) is distinct from 'object' or jsonb_typeof(v_o->'n') is distinct from 'number' or (v_o->>'n') !~ '^[1-9]$'
       or jsonb_typeof(v_o->'label') is distinct from 'string' or char_length(btrim(v_o->>'label')) = 0 then
      return jsonb_build_object('error', 'bad_request');
    end if;
    v_opts := v_opts || jsonb_build_array(jsonb_build_object('n', (v_o->>'n')::int, 'label', left(regexp_replace(v_o->>'label', '[[:cntrl:]]', ' ', 'g'), 200)));
  end loop;
  if p_options_full is not null then
    if jsonb_typeof(p_options_full) <> 'array' or jsonb_array_length(p_options_full) = 0 or jsonb_array_length(p_options_full) > 9 then
      return jsonb_build_object('error', 'bad_request');
    end if;
    v_full := '[]'::jsonb;
    for v_o in select * from jsonb_array_elements(p_options_full) loop
      if jsonb_typeof(v_o) is distinct from 'object' or jsonb_typeof(v_o->'n') is distinct from 'number' or (v_o->>'n') !~ '^[1-9]$'
         or jsonb_typeof(v_o->'label') is distinct from 'string' or char_length(btrim(v_o->>'label')) = 0
         or (v_o->>'n')::int = any (v_seen) then
        return jsonb_build_object('error', 'bad_request');
      end if;
      v_seen := v_seen || (v_o->>'n')::int;
      v_kind := case when v_o->>'kind' in ('allow_once', 'allow_always', 'deny', 'other') then v_o->>'kind' else 'other' end;
      v_full := v_full || jsonb_build_array(jsonb_build_object('n', (v_o->>'n')::int, 'label', left(regexp_replace(v_o->>'label', '[[:cntrl:]]', ' ', 'g'), 200), 'kind', v_kind));
    end loop;
    -- 舊手機用的選項，編號要是完整選項的子集（兩份都是畫面上的數字鍵）
    if exists (select 1 from jsonb_array_elements(v_opts) o where not ((o->>'n')::int = any (v_seen))) then
      return jsonb_build_object('error', 'bad_request');
    end if;
    -- 危險代碼：白名單以外的丟掉並標 uncertain；格式不對也當看不出全貌（照常收下，手機多一層小心）
    if p_risk is not null and jsonb_typeof(p_risk) = 'object' then
      v_uncertain := coalesce(jsonb_typeof(p_risk->'uncertain') = 'boolean' and (p_risk->>'uncertain')::boolean, false);
      if jsonb_typeof(p_risk->'codes') = 'array' then
        for v_c in select * from jsonb_array_elements(p_risk->'codes') loop
          if jsonb_typeof(v_c) = 'string' and (v_c #>> '{}') = any (c_known) then
            if not v_codes @> jsonb_build_array(v_c #>> '{}') and jsonb_array_length(v_codes) < 8 then
              v_codes := v_codes || jsonb_build_array(v_c #>> '{}');
            end if;
          else
            v_uncertain := true;
          end if;
        end loop;
      elsif p_risk ? 'codes' then
        v_uncertain := true;
      end if;
    else
      v_uncertain := true;
    end if;
    v_risk := jsonb_build_object('codes', v_codes, 'uncertain', v_uncertain);
  end if;
  perform public.asn_relay_perm_req_expire();
  if exists (select 1 from relay.perm_requests where node = p_node and window_name = p_window_name and status in ('pending', 'decided', 'taken')) then
    return jsonb_build_object('error', 'busy');
  end if;
  if (select count(*) from relay.perm_requests where node = p_node and created_at > now() - interval '1 hour') >= 60 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  insert into relay.perm_requests (tenant_id, node, window_name, prompt_text, complete, options, body_hash, options_full, risk, full_len)
    values (v_t, p_node, p_window_name, p_prompt_text, coalesce(p_complete, false), v_opts, p_hash, v_full, v_risk, case when v_full is null then null else p_full_len end)
    returning id, expires_at into v_id, v_exp;
  -- 敲本人其他設備的門鈴（手機開著就馬上跳；門鈴沒有內容）
  select coalesce(jsonb_agg(n.bell_topic), '[]'::jsonb) into v_topics
    from relay.nodes n where n.owner_user = v_owner and n.status = 'active' and n.id <> p_node and n.bell_topic is not null;
  return jsonb_build_object('id', v_id, 'expires_at', v_exp, 'bell_topics', v_topics);
end;
$function$;

-- 舊版（六個參數）：舊 relay 還在呼叫，轉給新版、新欄位給空的
create or replace function public.asn_relay_perm_req_create(p_node text, p_window_name text, p_prompt_text text, p_complete boolean, p_options jsonb, p_hash text)
 returns jsonb language sql security definer set search_path to ''
as $function$
  select public.asn_relay_perm_req_create(p_node, p_window_name, p_prompt_text, p_complete, p_options, p_hash, null::jsonb, null::jsonb, null::integer);
$function$;

-- 手機（本人簽章）列出：多回完整選項、危險代碼、截斷前字數（舊手機不看這幾欄）
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
      'options', r.options, 'body_hash', r.body_hash, 'expires_at', r.expires_at,
      'options_full', r.options_full, 'risk', r.risk, 'full_len', r.full_len) order by r.created_at), '[]'::jsonb)
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

-- 手機決定：數字在 options 或 options_full 裡都算；其他條件不變。結案清掉內容
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
  if not exists (select 1 from jsonb_array_elements(r.options) o where (o->>'n')::int = p_choice_n)
     and not exists (select 1 from jsonb_array_elements(coalesce(r.options_full, '[]'::jsonb)) o where (o->>'n')::int = p_choice_n) then
    return jsonb_build_object('error', 'bad_choice');
  end if;
  update relay.perm_requests set status = 'decided', choice_n = p_choice_n, decided_by = p_signed_user, decided_at = now(),
    prompt_text = null, options = null, options_full = null, risk = null where id = r.id;
  return jsonb_build_object('ok', true, 'status', 'decided');
end;
$function$;

-- 電腦回報結果：結案清掉內容（多清兩欄）
create or replace function public.asn_relay_perm_req_result(p_node text, p_id uuid, p_status text, p_detail text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_n int;
begin
  if p_status is null or p_status not in ('done', 'failed', 'cancelled') or p_id is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.perm_requests
    set status = p_status, detail = left(regexp_replace(coalesce(p_detail, ''), '[[:cntrl:]]', ' ', 'g'), 200), prompt_text = null, options = null, options_full = null, risk = null
    where id = p_id and node = p_node and status in ('pending', 'decided', 'taken');
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.asn_relay_perm_req_expire() from public, anon, authenticated;
revoke all on function public.asn_relay_perm_req_create(text, text, text, boolean, jsonb, text, jsonb, jsonb, integer) from public, anon, authenticated;
revoke all on function public.asn_relay_perm_req_create(text, text, text, boolean, jsonb, text) from public, anon, authenticated;
revoke all on function public.asn_relay_perm_req_list(text, uuid) from public, anon, authenticated;
revoke all on function public.asn_relay_perm_req_decide(text, uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.asn_relay_perm_req_result(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_perm_req_create(text, text, text, boolean, jsonb, text, jsonb, jsonb, integer) to service_role;
grant execute on function public.asn_relay_perm_req_create(text, text, text, boolean, jsonb, text) to service_role;
grant execute on function public.asn_relay_perm_req_list(text, uuid) to service_role;
grant execute on function public.asn_relay_perm_req_decide(text, uuid, uuid, integer, text) to service_role;
grant execute on function public.asn_relay_perm_req_result(text, uuid, text, text) to service_role;

commit;
