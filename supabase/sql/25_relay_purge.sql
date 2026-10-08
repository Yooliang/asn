-- 25_relay_purge.sql：往來紀錄（kv relay_log，每個聯絡人一串）超過保留天數的刪掉（小良哥 10/08：超過 30 天刪）。
-- 函式 public.irori_relay_purge(p_owner, p_before)：刪掉 at 早於 p_before 的紀錄，某位聯絡人刪光就整個拿掉；回傳刪了幾筆。
-- 跟 irori_relay_outbound／inbound 用同一把 advisory lock，清理時不會蓋掉剛寫進來的信。at 讀不懂的那筆留著（不猜）。
-- 執行方式：npx supabase db query --linked -f supabase/sql/25_relay_purge.sql（可重複執行）
-- 回復：supabase/sql/rollback/25_relay_purge_down.sql
-- 權限：revoke 掉 public／anon／authenticated，只授權 service_role（和 01～24 一致）。
begin;

create or replace function public.irori_relay_purge(p_owner uuid, p_before timestamptz) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_log jsonb;
  v_out jsonb := '{}'::jsonb;
  v_key text;
  v_items jsonb;
  v_kept jsonb;
  v_removed int := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('irori_relay:' || p_owner::text, 0));
  select value into v_log from irori.kv where owner = p_owner and key = 'relay_log';
  if v_log is null or jsonb_typeof(v_log) <> 'object' then return 0; end if;
  for v_key, v_items in select * from jsonb_each(v_log) loop
    if jsonb_typeof(v_items) <> 'array' then v_out := v_out || jsonb_build_object(v_key, v_items); continue; end if;
    select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) into v_kept
      from jsonb_array_elements(v_items) with ordinality t(e, ord)
      where not (coalesce(e ->> 'at', '') ~ '^\d{4}-\d{2}-\d{2}T' and (e ->> 'at')::timestamptz < p_before);
    v_removed := v_removed + jsonb_array_length(v_items) - jsonb_array_length(v_kept);
    if jsonb_array_length(v_kept) > 0 then v_out := v_out || jsonb_build_object(v_key, v_kept); end if;
  end loop;
  if v_removed > 0 then
    update irori.kv set value = v_out, updated_at = now() where owner = p_owner and key = 'relay_log';
  end if;
  return v_removed;
end;
$$;

revoke execute on function public.irori_relay_purge(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.irori_relay_purge(uuid, timestamptz) to service_role;

commit;
