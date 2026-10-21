-- 節點可以改「自己」的顯示名（relay.nodes.name）：ASN 啟動與使用者改暱稱時，把這台設備上 ASN 的視窗名寫進來，
-- 名單（list）本來就會帶出 name，別台設備的 ASN 前台就能用它當設備顯示名。
-- 只改 name、只改 p_node 自己這一列；長度 1～40（同視窗名）、去頭尾空白、不含控制字元。
-- owner 改別人的規則（irori_relay_update）不變。
create or replace function public.irori_relay_set_self_name(p_node text, p_name text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_name text := btrim(p_name);
begin
  if v_name is null or char_length(v_name) not between 1 and 40 or v_name ~ '[[:cntrl:]]' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update relay.nodes set name = v_name where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.irori_relay_set_self_name(text, text) from public, anon, authenticated;
grant execute on function public.irori_relay_set_self_name(text, text) to service_role;
