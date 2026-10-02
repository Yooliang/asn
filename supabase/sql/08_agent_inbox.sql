-- 08：視窗自己收信（#84）。只拿「寄給某個視窗」的信：to_node＝呼叫者節點 且 to_agent＝指定視窗名（精確相等）。
-- 不改表：relay.messages 已有 to_node／to_agent／acked_at。to_agent 是空的（總機信）永遠不會被這兩支函式碰到（null = 'x' 為 null）。
-- ack 也只動 to_agent＝該視窗的信，所以 A 視窗 ack 不到 B 視窗的信、也 ack 不到總機信。
-- 先跑這份 SQL，再部署 irori-relay；舊的 irori_relay_inbox／irori_relay_ack（機器橋用）完全不動。

create or replace function public.irori_relay_inbox_agent(p_node text, p_agent text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_ids uuid[];
  v_out jsonb;
begin
  if p_agent is null or p_agent = '' then return '[]'::jsonb; end if;
  select coalesce(array_agg(s.id), array[]::uuid[]) into v_ids from (
    select m.id from relay.messages m
    where m.to_node = p_node and m.to_agent = p_agent and m.acked_at is null
    order by m.created_at, m.id limit 50
  ) s;
  update relay.messages set delivered_at = now()
    where id = any(v_ids) and delivered_at is null;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'from_node', m.from_node, 'from_agent', m.from_agent,
      'to_node', m.to_node, 'to_agent', m.to_agent, 'body', m.body,
      'reply_to', m.reply_to, 'created_at', m.created_at,
      'trust', case when f.role = 'owner' then 'owner' else 'member' end) order by m.created_at, m.id), '[]'::jsonb)
    into v_out from relay.messages m join relay.nodes f on f.id = m.from_node where m.id = any(v_ids);
  return v_out;
end;
$$;

create or replace function public.irori_relay_ack_agent(p_node text, p_agent text, p_ids uuid[])
returns int
language plpgsql security definer set search_path = ''
as $$
declare v_n int;
begin
  if p_agent is null or p_agent = '' then return 0; end if;
  update relay.messages set acked_at = now()
    where to_node = p_node and to_agent = p_agent and id = any(p_ids) and acked_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.irori_relay_inbox_agent(text,text)',
    'public.irori_relay_ack_agent(text,text,uuid[])'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
