-- 帳號設定：對話釘選同步（#1479 第二部分，0.2.27）。電腦版與手機版共用同一份釘選。
-- 存在 relay.tenants.features 的 chat_pins，不新增資料表：
--   { "pins": [{id, at}…], "unpinned": [{id, at}…], "rev": 遞增版本號, "at": 伺服器寫入時間(毫秒) }
-- 兩支新函式：
--   relay.account_pref_put(p_user, p_key, p_val)：帳號層偏好的共用寫入（鎖帳號那一列、比 rev、2 秒冷卻、只換 features 裡的一個鍵）。
--     p_key 用白名單鎖住，目前只允許 'chat_pins'；寫入後整份 features 序列化超過 64KB（65536 bytes）就拒絕、不寫入。
--     只給函式擁有者（security definer 的 public 函式）呼叫，不授權任何角色。
--   public.asn_account_chat_pins(p_user, p_pins)：讀（p_pins 為空）與寫，只授權 service_role；寫入走 relay.account_pref_put('chat_pins', …)。
-- rev 是遞增版本號（不是時間戳）：寫入前必須先讀到最新那份，寫入的 rev 必須是「現有 rev＋1」（比對再寫入）。
--   現有的比寫入的 rev 小、一樣、或跳號（更大）一律不寫入，回傳現有的並標 stale。
--   還沒有現有那份（或現有那份不是物件）時，接受 rev ≥ 1（沒有東西可蓋，0.2.26 本機累積的 rev 第一次上傳不必先改號）；rev ＝ 0 拒絕（bad_rev）。
-- 衝突處理：兩台各自釘不同的對話時，後寫的那台會拿到 stale 與伺服器現有那份；
--   用戶端用 mergePins 合併（同一個 id 看 pins／unpinned 誰的 at 新，at 相同釘選勝），再以伺服器 rev＋1 重送。
--   重送最多 3 次；遇到冷卻（rate_limited）延後重試，不立刻連打。伺服器不合併。
-- 內容完全相同的寫入不動任何東西（不更新 rev、不算一次寫入）：這個捷徑放在 rev 比對之前，
--   所以內容一樣時不論 rev 是多少都回現有的（不標 stale）；用戶端合併後內容若已等於伺服器的，就不必再送。
-- 頻率限制：現有的 at 距今不到 2 秒、而且內容不同，回 rate_limited（Edge 轉 429）。
-- 伺服器只做結構檢查，不比用戶端嚴：pins 最多 50 筆、unpinned 最多 200 筆；每筆 id 是非空字串、最多 200 字、不含控制字元（中文與空白都放行）；at 是正數；rev 是 0～2^53 的整數。
-- 不動 asn_account_device_prefs 與 asn_account_settings，舊版用戶端與舊版 Edge 完全不受影響。
-- 回復：drop function public.asn_account_chat_pins(uuid, jsonb); drop function relay.account_pref_put(uuid, text, jsonb); drop function relay.chat_pins_list_ok(jsonb, int);
--       （features 裡的 chat_pins 鍵留著，不影響任何舊功能）。
begin;

-- 共用寫入。檢查順序：白名單 → 格式 → 鎖 → 內容相同捷徑 → rev 比對（stale）→ 冷卻 → 大小。
-- 內容相同捷徑在 rev 比對之前：內容已經一樣，重送沒有意義也不該被當成衝突；其餘情況一定要先過 rev 比對，才輪到冷卻與大小。
-- 回傳：{ value: 現在存著的 } ｜ { value, stale: true } ｜ { error: bad_request|not_found|rate_limited|too_large }
-- bad_request 會多帶 reason，方便 Edge 與測試辨認是哪一種。
create or replace function relay.account_pref_put(p_user uuid, p_key text, p_val jsonb)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_t relay.tenants%rowtype;
  v_cur jsonb;
  v_new jsonb;
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_rev numeric;
  v_features jsonb;
  c_max_features constant int := 65536;  -- features 整份序列化後的上限（bytes）
begin
  if p_user is null or p_key is null or p_val is null then
    return jsonb_build_object('error', 'bad_request', 'reason', 'missing_arg');
  end if;
  -- 白名單：之後要加新的帳號偏好，在這裡明列，不是任意鍵都能寫進 features
  if p_key not in ('chat_pins') then
    return jsonb_build_object('error', 'bad_request', 'reason', 'key_not_allowed');
  end if;
  if jsonb_typeof(p_val) <> 'object' or jsonb_typeof(p_val -> 'rev') is distinct from 'number' then
    return jsonb_build_object('error', 'bad_request', 'reason', 'bad_value');
  end if;
  v_rev := (p_val ->> 'rev')::numeric;
  if v_rev <> trunc(v_rev) or v_rev < 0 or v_rev > 9007199254740991 then
    return jsonb_build_object('error', 'bad_request', 'reason', 'bad_rev');
  end if;

  -- 鎖住帳號那一列（同一帳號兩台設備同時寫入時，第二個等第一個提交再用新資料檢查）
  select * into v_t from relay.tenants where owner_user = p_user for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  v_cur := v_t.features -> p_key;
  if v_cur is not null and jsonb_typeof(v_cur) <> 'object' then
    v_cur := null;
  end if;

  -- rev 與 at 由這裡統一處理：rev 用寫入的、at 用伺服器時間
  v_new := (p_val - 'rev' - 'at') || jsonb_build_object('rev', v_rev::bigint, 'at', v_now);

  if v_cur is not null then
    -- 內容（不含 rev、at）完全相同：不動，回現有的
    if (v_cur - 'rev' - 'at') = (v_new - 'rev' - 'at') then
      return jsonb_build_object('value', v_cur);
    end if;
    -- 比對再寫入：只接受現有 rev＋1；更小、一樣、跳號都不寫，回現有的讓用戶端合併後重送
    if v_rev <> coalesce((v_cur ->> 'rev')::numeric, 0) + 1 then
      return jsonb_build_object('value', v_cur, 'stale', true);
    end if;
    -- 太頻繁
    if v_now - coalesce((v_cur ->> 'at')::bigint, 0) < 2000 then
      return jsonb_build_object('error', 'rate_limited');
    end if;
  elsif v_rev < 1 then
    -- 還沒有現有那份：rev ≥ 1 都收（本機累積的號碼不用改），0 拒絕
    return jsonb_build_object('error', 'bad_request', 'reason', 'bad_rev');
  end if;

  -- 整份 features 寫入後不能超過上限；超過就不寫（原值不變）
  v_features := coalesce(v_t.features, '{}'::jsonb) || jsonb_build_object(p_key, v_new);
  if octet_length(v_features::text) > c_max_features then
    return jsonb_build_object('error', 'too_large');
  end if;

  update relay.tenants set features = v_features where id = v_t.id;
  return jsonb_build_object('value', v_new);
end;
$function$;

-- 一份清單（pins／unpinned）：陣列、最多 p_max 筆、每筆是物件，id 為 1～200 字的字串且不含控制字元，at 是 0 到 2^53 之間的正數
create or replace function relay.chat_pins_list_ok(p_arr jsonb, p_max int)
 returns boolean language sql immutable set search_path to ''
as $function$
  select p_arr is not null
     and jsonb_typeof(p_arr) = 'array'
     and jsonb_array_length(p_arr) <= p_max
     and not exists (
       select 1 from jsonb_array_elements(p_arr) e
       where jsonb_typeof(e) <> 'object'
          or jsonb_typeof(e -> 'id') is distinct from 'string'
          or char_length(e ->> 'id') not between 1 and 200
          or (e ->> 'id') ~ '[\x01-\x1f\x7f]'
          or jsonb_typeof(e -> 'at') is distinct from 'number'
          or (e ->> 'at')::numeric <= 0
          or (e ->> 'at')::numeric > 9007199254740991
     );
$function$;

create or replace function public.asn_account_chat_pins(p_user uuid, p_pins jsonb default null)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_cur jsonb;
  v_r jsonb;
  v_rev numeric;
begin
  if p_user is null then
    return jsonb_build_object('error', 'bad_request');
  end if;

  -- 讀：沒設過回 null
  if p_pins is null or p_pins = 'null'::jsonb then
    select t.features -> 'chat_pins' into v_cur from relay.tenants t where t.owner_user = p_user;
    if not found then
      return jsonb_build_object('error', 'not_found');
    end if;
    if v_cur is not null and jsonb_typeof(v_cur) <> 'object' then
      v_cur := null;
    end if;
    return jsonb_build_object('pins', v_cur);
  end if;

  -- 驗證（只做結構，不合併；id 規則不比用戶端嚴）
  if jsonb_typeof(p_pins) <> 'object'
     or not relay.chat_pins_list_ok(p_pins -> 'pins', 50)
     or not relay.chat_pins_list_ok(p_pins -> 'unpinned', 200)
     or jsonb_typeof(p_pins -> 'rev') is distinct from 'number' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  v_rev := (p_pins ->> 'rev')::numeric;
  if v_rev <> trunc(v_rev) or v_rev < 0 or v_rev > 9007199254740991 then
    return jsonb_build_object('error', 'bad_request');
  end if;

  -- 只留我們認得的三個欄位（at 由共用寫入補），多餘的欄位不存；每筆也只留 id、at
  v_r := relay.account_pref_put(p_user, 'chat_pins', jsonb_build_object(
    'pins', (select coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'id', 'at', e -> 'at') order by o), '[]'::jsonb) from jsonb_array_elements(p_pins -> 'pins') with ordinality as t(e, o)),
    'unpinned', (select coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'id', 'at', e -> 'at') order by o), '[]'::jsonb) from jsonb_array_elements(p_pins -> 'unpinned') with ordinality as t(e, o)),
    'rev', p_pins -> 'rev'));

  if v_r ? 'error' then
    return v_r;
  end if;
  return jsonb_build_object('pins', v_r -> 'value') || case when v_r ? 'stale' then jsonb_build_object('stale', true) else '{}'::jsonb end;
end;
$function$;

revoke all on function relay.account_pref_put(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function relay.chat_pins_list_ok(jsonb, int) from public, anon, authenticated;
revoke all on function public.asn_account_chat_pins(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.asn_account_chat_pins(uuid, jsonb) to service_role;

commit;
