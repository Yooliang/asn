-- 設備順序同步（asn_account_device_prefs）：讀取帳號那一列時加 for update（#253）。
-- 原本沒有鎖：同一帳號兩台設備同時寫入，兩個交易讀到同一份舊資料、都通過 rev 與 2 秒冷卻的檢查，
-- 後寫的會蓋掉先寫的（即使 rev 較舊）。加鎖後第二個交易會等第一個提交，再用新的資料檢查。
-- 只改這一行，其餘與 20261025010000 完全相同；簽名與授權不變。
-- 回復：重新套用 20261025010000_account_device_prefs.sql 裡的函式定義。
begin;

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
  select * into v_t from relay.tenants where owner_user = p_user for update;
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

revoke all on function public.asn_account_device_prefs(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.asn_account_device_prefs(uuid, jsonb) to service_role;

commit;
