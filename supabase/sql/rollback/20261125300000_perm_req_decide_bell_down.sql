-- 退回 20261125300000_perm_req_decide_bell.sql：把 asn_relay_perm_req_decide 與 asn_relay_term_req_decide 各換回 20261114100000 的原文（不再回 bell_topic）。簽名不變，權限沿用。
begin;

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

-- term_req：換回 20261026400000 的原文
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

commit;
