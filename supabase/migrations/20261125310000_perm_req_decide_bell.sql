-- #2161 第 3d-1 段：手機決定權限框（perm_req）與終端確認（term_req）成功後，後台要敲「擁有該請求那台電腦」的門鈴。
-- term_req 的 asn_relay_term_req_decide 同型修正：approve 與 deny 兩種結果都回 bell_topic（客戶端要領回結果）。
-- 做法：asn_relay_perm_req_decide 成功時多回一個 bell_topic（該請求所屬節點 r.node 的門鈴頻道）；其餘行為與 20261114100000 逐字相同。
--   bell_topic 是門鈴頻道秘密，只給 Edge 內部用，Edge 不會把它回給客戶端。節點沒有 bell_topic 時鍵仍在、值為 JSON null（Edge 只認字串）。
--   失敗路徑（forbidden／bad_request／not_found／hash_mismatch／bad_choice）一律不含 bell_topic。
-- 權限：簽名不變，create or replace 會保留原有的 grant／revoke（只給 service_role），所以這裡不重做授權。
-- 回復：supabase/sql/rollback/20261125310000_perm_req_decide_bell_down.sql（把函式換回 20261114100000 的原文）。
begin;

-- 手機決定：數字在 options 或 options_full 裡都算；其他條件不變。結案清掉內容；成功時多回該電腦的門鈴頻道
create or replace function public.asn_relay_perm_req_decide(p_actor text, p_signed_user uuid, p_id uuid, p_choice_n integer, p_hash text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  r relay.perm_requests%rowtype;
  v_topic text;
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
  select n.bell_topic into v_topic from relay.nodes n where n.id = r.node;
  return jsonb_build_object('ok', true, 'status', 'decided', 'bell_topic', v_topic);
end;
$function$;

-- 手機決定終端確認：approve／deny 成功時多回該電腦的門鈴頻道；其餘與 20261026400000 逐字相同
create or replace function public.asn_relay_term_req_decide(p_actor text, p_signed_user uuid, p_id uuid, p_decision text, p_choice_n integer, p_hash text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  r relay.term_requests%rowtype;
  v_topic text;
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
    select n.bell_topic into v_topic from relay.nodes n where n.id = r.node;
    return jsonb_build_object('ok', true, 'status', 'denied', 'bell_topic', v_topic);
  end if;
  if r.kind = 'answer' then
    if p_choice_n is null or not exists (select 1 from jsonb_array_elements(r.options) o where (o->>'n')::int = p_choice_n) then
      return jsonb_build_object('error', 'bad_choice');
    end if;
  elsif p_choice_n is not null then
    return jsonb_build_object('error', 'bad_choice');
  end if;
  update relay.term_requests set status = 'approved', choice_n = p_choice_n, decided_by = p_signed_user, decided_at = now() where id = r.id;
  select n.bell_topic into v_topic from relay.nodes n where n.id = r.node;
  return jsonb_build_object('ok', true, 'status', 'approved', 'bell_topic', v_topic);
end;
$function$;

commit;
