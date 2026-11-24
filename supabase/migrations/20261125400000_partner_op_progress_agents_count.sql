-- #1908 換班接手等前任的子代理做完：進度階段代號可以帶件數（stage:agents:3）。
-- 原本只收 stage:<小寫字母>；現在多收 stage:<小寫字母>:<1~3 位數字>。其他格式照舊擋掉。
begin;

create or replace function public.asn_relay_partner_op_progress(p_node text, p_id uuid, p_detail text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_n int;
begin
  if p_detail is null or p_detail !~ '^stage:[a-z]{1,20}(:[0-9]{1,3})?$' then
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

revoke all on function public.asn_relay_partner_op_progress(text, uuid, text) from public, anon, authenticated;
grant execute on function public.asn_relay_partner_op_progress(text, uuid, text) to service_role;

commit;
