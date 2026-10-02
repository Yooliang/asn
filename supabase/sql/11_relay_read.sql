-- 11：一對一聊天的「讀到哪」放後端（kv relay_read），各裝置未讀數一致。可重複執行。
--   relay_read = { 聯絡人 id: { id, at } }，id／at 是 relay_log 裡該聯絡人最後一則的 id 與時間。
-- 標已讀＝記到「目前最新一則」。跟寄信／收信共用同一把 advisory lock，不會和寫 relay_log 的交易交錯。
create or replace function public.irori_relay_mark_read(p_owner uuid, p_contact text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_log jsonb;
  v_read jsonb;
  v_last jsonb;
  v_pos jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('irori_relay:' || p_owner::text, 0));
  select value into v_log from irori.kv where owner = p_owner and key = 'relay_log';
  if v_log is null or jsonb_typeof(v_log) <> 'object' then return null; end if;
  v_last := (v_log -> p_contact) -> -1;
  if v_last is null or jsonb_typeof(v_last) <> 'object' then return null; end if;
  v_pos := jsonb_build_object('id', v_last -> 'id', 'at', v_last -> 'at');
  select value into v_read from irori.kv where owner = p_owner and key = 'relay_read';
  if v_read is null or jsonb_typeof(v_read) <> 'object' then v_read := '{}'::jsonb; end if;
  v_read := jsonb_set(v_read, array[p_contact], v_pos, true);
  insert into irori.kv (owner, key, value) values (p_owner, 'relay_read', v_read)
    on conflict (owner, key) do update set value = excluded.value, updated_at = now();
  return v_pos;
end;
$$;
revoke all on function public.irori_relay_mark_read(uuid, text) from public, anon, authenticated;
grant execute on function public.irori_relay_mark_read(uuid, text) to service_role;

-- 上線基準：還沒有 relay_read 的人，把現有的每位聯絡人都先標成已讀，
-- 否則沒有已讀位置＝整段歷史的收信都算未讀（每人最多一整串）。
insert into irori.kv (owner, key, value)
select l.owner, 'relay_read', coalesce((
  select jsonb_object_agg(c.key, jsonb_build_object('id', (c.value -> -1) -> 'id', 'at', (c.value -> -1) -> 'at'))
  from jsonb_each(l.value) c
  where jsonb_typeof(c.value) = 'array' and jsonb_array_length(c.value) > 0
), '{}'::jsonb)
from irori.kv l
where l.key = 'relay_log' and jsonb_typeof(l.value) = 'object'
on conflict (owner, key) do nothing;

notify pgrst, 'reload schema';
