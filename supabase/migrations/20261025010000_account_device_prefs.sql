-- 帳號設定：設備順序同步（電腦版與手機版共用同一份 deviceOrder／deviceShown／deviceRemoved）。
-- 存在 relay.tenants.features 的 device_prefs，不新增資料表：
--   { "order": [節點鍵…], "shown": [節點鍵…], "removed": [節點鍵…], "rev": 毫秒時間戳, "at": 伺服器寫入時間(毫秒) }
-- 衝突處理：整份以 rev 較新的為準（last-writer-wins）。寫入的 rev 必須比現有的大，否則不覆蓋、回傳現有的並標 stale。
-- 內容完全相同的寫入不動任何東西（不更新 rev、不算一次寫入）。
-- 頻率限制：現有的 at 距今不到 2 秒、而且內容不同，回 rate_limited（Edge 轉 429）；用戶端本來就節流 5 秒以上。
-- 驗證：三個陣列都是字串陣列，元素符合節點鍵格式 [A-Za-z0-9_-]{1,32}，每個最多 200 個、不可重複；rev 是 0～2^53 的整數。
-- 不動既有的 asn_account_settings（簽名不變），舊版用戶端與舊版 Edge 完全不受影響。
-- 回復：drop function public.asn_account_device_prefs(uuid, jsonb);（features 裡的 device_prefs 留著不影響任何舊功能）。
begin;

-- 驗證一個陣列欄位：字串陣列、最多 200 個、元素符合節點鍵格式、不重複
create or replace function relay.device_prefs_list_ok(p_arr jsonb)
 returns boolean language sql immutable set search_path to ''
as $function$
  select p_arr is not null
     and jsonb_typeof(p_arr) = 'array'
     and jsonb_array_length(p_arr) <= 200
     and not exists (select 1 from jsonb_array_elements(p_arr) e where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^[A-Za-z0-9_-]{1,32}$')
     and (select count(*) = count(distinct e #>> '{}') from jsonb_array_elements(p_arr) e);
$function$;

create or replace function public.asn_account_device_prefs(p_user uuid, p_prefs jsonb default null)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_t relay.tenants%rowtype;
  v_cur jsonb;
  v_new jsonb;
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_rev numeric;
begin
  if p_user is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select * into v_t from relay.tenants where owner_user = p_user;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  v_cur := v_t.features -> 'device_prefs';
  if v_cur is not null and jsonb_typeof(v_cur) <> 'object' then
    v_cur := null;
  end if;

  -- 讀：沒設過回 null
  if p_prefs is null or p_prefs = 'null'::jsonb then
    return jsonb_build_object('prefs', v_cur);
  end if;

  -- 驗證
  if jsonb_typeof(p_prefs) <> 'object'
     or not relay.device_prefs_list_ok(p_prefs -> 'order')
     or not relay.device_prefs_list_ok(p_prefs -> 'shown')
     or not relay.device_prefs_list_ok(p_prefs -> 'removed')
     or jsonb_typeof(p_prefs -> 'rev') is distinct from 'number' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  v_rev := (p_prefs ->> 'rev')::numeric;
  if v_rev <> trunc(v_rev) or v_rev < 0 or v_rev > 9007199254740991 then
    return jsonb_build_object('error', 'bad_request');
  end if;

  v_new := jsonb_build_object('order', p_prefs -> 'order', 'shown', p_prefs -> 'shown', 'removed', p_prefs -> 'removed', 'rev', v_rev::bigint, 'at', v_now);

  if v_cur is not null then
    -- 內容完全相同：不動，回現有的
    if (v_cur -> 'order') = (v_new -> 'order') and (v_cur -> 'shown') = (v_new -> 'shown') and (v_cur -> 'removed') = (v_new -> 'removed') then
      return jsonb_build_object('prefs', v_cur);
    end if;
    -- 對方的比較新（或一樣新）：不覆蓋，讓用戶端去合併
    if coalesce((v_cur ->> 'rev')::numeric, 0) >= v_rev then
      return jsonb_build_object('prefs', v_cur, 'stale', true);
    end if;
    -- 太頻繁
    if v_now - coalesce((v_cur ->> 'at')::bigint, 0) < 2000 then
      return jsonb_build_object('error', 'rate_limited');
    end if;
  end if;

  update relay.tenants set features = coalesce(features, '{}'::jsonb) || jsonb_build_object('device_prefs', v_new) where id = v_t.id;
  return jsonb_build_object('prefs', v_new);
end;
$function$;

revoke all on function relay.device_prefs_list_ok(jsonb) from public, anon, authenticated;
revoke all on function public.asn_account_device_prefs(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.asn_account_device_prefs(uuid, jsonb) to service_role;

commit;
