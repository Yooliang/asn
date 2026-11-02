-- 收發室 worker 的 Claude 額度用完時，這台電腦暫停收信到什麼時候（todo-next-173）：給收信監控用來抑制「長時間沒收信」的通知。
-- 做法照 20261023090000_mod_status.sql 的 asn_relay_set_claude_mod：節點用自己的金鑰回報（Edge Function relay 的 roster 動作選填欄位），
-- 資料庫函式只動得到金鑰所屬的那一列，只授權 service_role。
--  1. relay.nodes 加 inbox_hold_until（可空）；null＝沒有暫停。
--  2. asn_relay_set_inbox_hold(p_node, p_until)：傳入值由這裡夾在 now() 到 now()+8 天之間（不信用戶端的時間）；傳 null＝清掉。
--     節點不存在或已停用回 forbidden。
-- 相容：只新增可空欄位與新函式，沒有改既有函式；舊電腦端不帶欄位＝不動，舊後台沒有這個欄位時電腦端的值被丟掉，不壞。
-- 部署順序：本 migration → relay（Edge Function）→ 電腦端。
--   部署：npx supabase db query --linked -f supabase/migrations/20261101100000_inbox_hold_until.sql
-- 回復：supabase/sql/rollback/20261101100000_inbox_hold_until_down.sql
begin;

alter table relay.nodes add column if not exists inbox_hold_until timestamptz;

create or replace function public.asn_relay_set_inbox_hold(p_node text, p_until timestamptz)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  update relay.nodes set
      inbox_hold_until = case when p_until is null then null
        else least(greatest(p_until, now()), now() + interval '8 days') end
    where id = p_node and status = 'active';
  if not found then
    return jsonb_build_object('error', 'forbidden');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;
revoke all on function public.asn_relay_set_inbox_hold(text, timestamptz) from public, anon, authenticated;
grant execute on function public.asn_relay_set_inbox_hold(text, timestamptz) to service_role;

commit;
