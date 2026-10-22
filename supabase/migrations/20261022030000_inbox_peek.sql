-- 視窗收信「只看不收」（asn-cli recv --peek，給 Claude Code mod 狀態列顯示未讀數用）。
-- 既有的 irori_relay_inbox／irori_relay_inbox_agent 讀信時會把 delivered_at 設成現在，不能拿來輪詢；
-- 這支是純讀取：stable、只有 select，不 update、不改 delivered_at／acked_at，也不碰任何表的狀態。
-- 隔離規則同 inbox_agent：to_node = p_node 且 to_agent = p_agent 精確比對，to_agent 為空的總機信不算。
-- 回傳 {"count": 該視窗全部未 ack 的信數, "messages": [最舊的最多 50 封：id, from_node, from_agent, created_at, body 前 200 字]}。
-- 新增函式，舊用戶端與舊函式完全不受影響。
begin;

create or replace function public.irori_relay_inbox_peek(p_node text, p_agent text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_count integer;
  v_msgs jsonb;
begin
  if p_agent is null or p_agent = '' then
    return jsonb_build_object('count', 0, 'messages', '[]'::jsonb);
  end if;
  select count(*) into v_count from relay.messages m
    where m.to_node = p_node and m.to_agent = p_agent and m.acked_at is null;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'from_node', s.from_node, 'from_agent', s.from_agent,
      'created_at', s.created_at, 'body', left(s.body, 200)) order by s.created_at, s.id), '[]'::jsonb)
    into v_msgs from (
      select m.id, m.from_node, m.from_agent, m.created_at, m.body from relay.messages m
      where m.to_node = p_node and m.to_agent = p_agent and m.acked_at is null
      order by m.created_at, m.id limit 50
    ) s;
  return jsonb_build_object('count', v_count, 'messages', v_msgs);
end;
$function$;

revoke all on function public.irori_relay_inbox_peek(text, text) from public, anon, authenticated;
grant execute on function public.irori_relay_inbox_peek(text, text) to service_role;

commit;
