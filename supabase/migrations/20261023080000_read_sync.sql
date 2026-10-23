-- 已讀多端同步：記「這個帳號（本人）在某個對話讀到哪一則」，電腦與手機（可能多台）共用。
-- 鍵（key）：有夥伴 ID 用夥伴 ID（p_…）；沒有用「n:節點/名字」；群組用「g:群組代號」。由用戶端算（ui/lib/read-sync.mjs），這裡只當字串存。
-- 已讀位置（read_at）：該對話「最後一則收到的信」的時間（毫秒），用信件自己的時間而不是設備的時鐘，所以各設備時鐘不準也不會錯。
-- 只往前不往後：寫入一律取較大者（greatest），舊設備晚送、重送、亂序都不會把已讀倒退。
-- 一次呼叫同時寫入與取回（p_marks 可以是空陣列）：用戶端節流後打一次就完成「回寫＋合併」。
-- 本人簽章（p_signed_user，Edge Function 驗過登入憑證才傳進來），且簽章的人要擁有呼叫節點；沒簽章／不擁有一律 forbidden。
-- 先不套用：部署順序為 migration → relay 函式 → 發新版 ASN（反過來也安全：舊後台對 read_sync 回 404，新端靜默退回本機行為）。
begin;

create table if not exists relay.read_marks (
  user_id uuid not null,
  key text not null check (char_length(key) between 3 and 140),
  read_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
create index if not exists read_marks_updated_idx on relay.read_marks (updated_at);
alter table relay.read_marks enable row level security;
revoke all on relay.read_marks from public, anon, authenticated;

create or replace function public.asn_relay_read_sync(p_actor text, p_signed_user uuid, p_marks jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  m jsonb;
  v_ms numeric;
begin
  if p_signed_user is null or p_actor is null
     or not exists (select 1 from relay.nodes where id = p_actor and status = 'active' and public.asn_user_owns_node(p_signed_user, p_actor)) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_marks is null or jsonb_typeof(p_marks) <> 'array' or jsonb_array_length(p_marks) > 100 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 先全部檢查再寫，壞一筆就整批不寫
  for m in select * from jsonb_array_elements(p_marks) loop
    -- 欄位缺少時 jsonb_typeof 會是 null（比較結果不成立），所以一律用 coalesce 與 case 逐層判斷，缺欄位也算壞格式
    if coalesce(jsonb_typeof(m), '') <> 'object' or coalesce(jsonb_typeof(m->'key'), '') <> 'string' or coalesce(jsonb_typeof(m->'at'), '') <> 'number' then
      return jsonb_build_object('error', 'bad_request');
    end if;
    if char_length(m->>'key') not between 3 and 140 or (m->>'at')::numeric <= 0 or (m->>'at')::numeric > 4102444800000 then
      return jsonb_build_object('error', 'bad_request');
    end if;
  end loop;
  -- 每個帳號最多 2000 個對話鍵（只擋新增，已有的照常更新）
  if (select count(*) from relay.read_marks where user_id = p_signed_user) >= 2000
     and exists (select 1 from jsonb_array_elements(p_marks) e
                 where not exists (select 1 from relay.read_marks r where r.user_id = p_signed_user and r.key = e->>'key')) then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  for m in select * from jsonb_array_elements(p_marks) loop
    v_ms := (m->>'at')::numeric;
    insert into relay.read_marks (user_id, key, read_at)
      values (p_signed_user, m->>'key', least(to_timestamp(v_ms / 1000.0), now() + interval '5 minutes'))
      on conflict (user_id, key) do update
        set read_at = greatest(relay.read_marks.read_at, excluded.read_at),
            updated_at = case when excluded.read_at > relay.read_marks.read_at then now() else relay.read_marks.updated_at end;
  end loop;
  -- 信件只留 90 天，超過的已讀位置也沒有用
  delete from relay.read_marks where user_id = p_signed_user and updated_at < now() - interval '90 days';
  return jsonb_build_object('ok', true, 'marks', coalesce((
    select jsonb_object_agg(key, floor(extract(epoch from read_at) * 1000)::bigint) from relay.read_marks where user_id = p_signed_user
  ), '{}'::jsonb));
end;
$function$;
revoke all on function public.asn_relay_read_sync(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.asn_relay_read_sync(text, uuid, jsonb) to service_role;

commit;
