-- 電腦端回報「別台能不能看這台的畫面、能不能在這台打字」兩個開關（#1751）。
-- 只是給後台與網頁的提示，不是權威：別台真的要看或打字時，被看的那台在握手時仍會自己再查一次本機設定，後台記的值不影響結果。
--  1. relay.nodes 加三個可為 null 的欄位：remote_view、remote_input（布林）、remote_flags_at（最後一次回報時間）。
--     null＝不知道（舊版電腦沒回報、或還沒回報過）；網頁看到 null 照常發出要求，不因此擋人。
--  2. asn_relay_set_remote_flags(p_node, p_view, p_input)：只改金鑰所屬的自己節點（p_node 由 Edge 取自金鑰）。
--     參數為 null＝這次沒帶（保留舊值，不會把已知的值洗成不知道）；兩個都是 null 什麼都不寫。
--  3. 這支 migration 不改 asn_relay_list：名單先不回這兩個欄位（和 launch_closed_reason 一樣不在名單裡，網頁要讀時另加動作）。
-- 全部是新增，舊版用戶端與舊 Edge 不受影響。函式 security definer、search_path 空、只授權 service_role。
-- 回復：supabase/sql/rollback/20261119300000_remote_flags_down.sql。
begin;

alter table relay.nodes add column if not exists remote_view boolean;
alter table relay.nodes add column if not exists remote_input boolean;
alter table relay.nodes add column if not exists remote_flags_at timestamptz;

create or replace function public.asn_relay_set_remote_flags(p_node text, p_view boolean, p_input boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if p_view is null and p_input is null then
    return jsonb_build_object('ok', true, 'changed', false);
  end if;
  update relay.nodes set
      remote_view = coalesce(p_view, remote_view),
      remote_input = coalesce(p_input, remote_input),
      remote_flags_at = now()
    where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  return jsonb_build_object('ok', true, 'changed', true);
end;
$function$;
revoke all on function public.asn_relay_set_remote_flags(text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_set_remote_flags(text, boolean, boolean) to service_role;

commit;
