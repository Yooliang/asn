-- 本人替雲端設備改名（#837）：電腦、手機的設備名是那台 ASN 自己的視窗名（set_self_name），只有雲端節點要從畫面上改。
-- 身分由 Edge Function 驗過登入憑證後帶入 p_user；只授權 service_role。
--  1. 只改自己名下、created_via = 'cloud-invite'、啟用中的節點；別人的、電腦、手機、不存在一律 not_found（同 asn_cloud_node_revoke）。
--  2. 名字規則同 set_self_name：去頭尾空白、1～40 字、不含控制字元。
--  3. 只改設備名（nodes.name），不動 bot 名（roster 由代理自己回報）。
--  4. 群組裡整台設備當成員（member = 節點代號）且另存的顯示名等於舊名時，跟著改成新名；空的本來就讀 nodes.name，不用動；
--     bot 成員（節點代號~bot 名）的顯示名是 bot 名，不動。
--  5. 寫一筆 account_events（cloud_node_renamed，detail 記新舊名）。
-- 先不套用：部署由負責的 session 處理。回復做法：supabase/sql/rollback/20261106120000_cloud_node_rename_down.sql
begin;

create or replace function public.asn_cloud_node_rename(p_user uuid, p_node text, p_name text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_name text := btrim(p_name);
  v_old text;
  v_rooms int := 0;
begin
  if p_user is null or p_node is null or v_name is null or char_length(v_name) not between 1 and 40 or v_name ~ '[[:cntrl:]]' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select n.name into v_old from relay.nodes n
   where n.id = p_node and n.owner_user = p_user and n.status = 'active' and n.created_via = 'cloud-invite'
   for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_old is not distinct from v_name then
    return jsonb_build_object('ok', true, 'name', v_name, 'changed', false);
  end if;
  update relay.nodes set name = v_name where id = p_node;
  update relay.room_members set display_name = v_name
   where member = p_node and display_name = v_old;
  get diagnostics v_rooms = row_count;
  insert into relay.account_events (user_id, event, node, detail)
    values (p_user, 'cloud_node_renamed', p_node, jsonb_build_object('from', v_old, 'to', v_name, 'rooms', v_rooms));
  return jsonb_build_object('ok', true, 'name', v_name, 'changed', true);
end;
$function$;
revoke all on function public.asn_cloud_node_rename(uuid, text, text) from public, anon, authenticated;
grant execute on function public.asn_cloud_node_rename(uuid, text, text) to service_role;

commit;
