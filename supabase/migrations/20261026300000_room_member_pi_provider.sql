-- 群組成員的廠商小圖：pi 只是執行殼，頭像右下角要看得出它背後用的是哪一家（小良哥 #404）。
-- 只改 relay.room_member_presence 一處（以線上現行定義、20261025000000 為底，其餘逐字不變）：
--   AI 視窗的 roster.engine 是 pi，而且 roster.model 是「提供者/模型」的寫法時，多帶一個 provider ＝提供者那一段
--   （只收英數與 . _ -，轉小寫，最多 30 字；其餘不帶）。不帶完整模型名，也不帶節點代號、設備名與時間；外部帳號的成員也只拿到這一欄。
-- 相容：全部是新增欄位，舊用戶端照舊（沒有 provider 就用 engine 的圖）；新用戶端沒有 provider 就退回原本的圖。
-- 回復：把 20261025000000 的 room_member_presence 定義再套一次。
begin;

create or replace function relay.room_member_presence(p_member text)
 returns jsonb language sql stable security definer set search_path to ''
as $function$
  select case
    when p_member like '~%' then '{}'::jsonb
    when position('~' in p_member) > 0 then (
      select jsonb_strip_nulls(jsonb_build_object('online', coalesce(r.seen_at > now() - interval '3 minutes', false), 'engine', coalesce(r.engine, case when n.kind in ('claude','gpt','gemini','grok') then n.kind end),
        'provider', case when r.engine = 'pi' and position('/' in coalesce(r.model, '')) > 1 and lower(split_part(r.model, '/', 1)) ~ '^[a-z0-9._-]{1,30}$' then lower(split_part(r.model, '/', 1)) end))
      from (select 1) d
      left join relay.roster r on r.node = split_part(p_member, '~', 1) and r.name = substr(p_member, position('~' in p_member) + 1)
      left join relay.nodes n on n.id = split_part(p_member, '~', 1))
    else (
      select jsonb_strip_nulls(jsonb_build_object('online', coalesce(n.last_seen_at > now() - interval '3 minutes', false), 'engine', case when n.kind in ('claude','gpt','gemini','grok') then n.kind end))
      from (select 1) d left join relay.nodes n on n.id = p_member)
  end;
$function$;

revoke all on function relay.room_member_presence(text) from public, anon, authenticated;

commit;
