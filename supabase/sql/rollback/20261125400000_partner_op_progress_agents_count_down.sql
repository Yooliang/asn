-- 回復 20261125400000_partner_op_progress_agents_count.sql：階段代號只收 stage:<小寫字母>（不帶件數）。
-- 本體取自 20261022120000_partner_ops.sql 的 irori_relay_partner_op_progress（後來改名成 asn_ 版，本體相同）。
-- 已經寫進 detail 的 stage:agents:N 不動（只是之後電腦端再回報帶件數的格式會被後台擋成 bad_request，電腦端當作忽略）。
begin;

create or replace function public.asn_relay_partner_op_progress(p_node text, p_id uuid, p_detail text)
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

revoke all on function public.asn_relay_partner_op_progress(text, uuid, text) from public, anon, authenticated;
grant execute on function public.asn_relay_partner_op_progress(text, uuid, text) to service_role;

commit;
