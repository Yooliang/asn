-- 09：寄件人查自己寄出的信的狀態（希緒常不確定信有沒有送到而重寄）。只回 from_node＝呼叫者的信。
-- delivered_at＝對方信箱已拉到；acked_at＝對方已收下處理。可重複執行。
create or replace function public.irori_relay_sent_status(p_node text, p_ids uuid[])
returns jsonb
language sql security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'delivered_at', m.delivered_at, 'acked_at', m.acked_at)), '[]'::jsonb)
  from relay.messages m
  where m.from_node = p_node and m.id = any(coalesce(p_ids, array[]::uuid[]));
$$;
revoke all on function public.irori_relay_sent_status(text, uuid[]) from public, anon, authenticated;
grant execute on function public.irori_relay_sent_status(text, uuid[]) to service_role;
