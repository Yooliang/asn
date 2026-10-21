-- 寄件人查自己寄出的信：多回 replied_at（任一則 reply_to 指向該 id 的最早時間）。
-- 只回 from_node＝呼叫者的列；子查詢綁在該列 id 上，不會洩漏他人信件。
begin;

create or replace function public.irori_relay_sent_status(p_node text, p_ids uuid[])
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', m.id,
        'delivered_at', m.delivered_at,
        'acked_at', m.acked_at,
        'replied_at', (
          select min(r.created_at)
          from relay.messages r
          where r.reply_to = m.id
        )
      )
    ),
    '[]'::jsonb
  )
  from relay.messages m
  where m.from_node = p_node
    and m.id = any(coalesce(p_ids, array[]::uuid[]));
$$;

revoke all on function public.irori_relay_sent_status(text, uuid[]) from public, anon, authenticated;
grant execute on function public.irori_relay_sent_status(text, uuid[]) to service_role;

commit;
