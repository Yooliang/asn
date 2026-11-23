-- 換新設備時處理舊設備（#1860 H，PR-1 只有後台）：新的一台第一次回報平台後，若同一個帳號底下有「同平台、目前離線、
--   而且最後上線早於這台新設備建立」的舊設備，通知本人「有一台新的電腦連上了」，並讓本人在設定頁選：這台取代哪一台舊的／不取代（兩台都留、不再問）。
--   為什麼不用「離線多久」：重灌時舊設備通常剛離線，用天數門檻會漏掉最常見的情況；剛睡著的電腦只要醒來一次
--   （最後上線晚於新設備建立）就自動排除，不會被誤當成舊的。
-- 這個 migration 做五件事：
--   1. relay.nodes 加兩欄：
--        replace_asked_at       使用者已回答過（取代或不取代）的時間；有值＝不再出卡、不再通知。
--        new_device_noticed_at  已經寄過「新設備」通知的時間。「只通知一次」的做法選這個獨立欄位：
--                               new_device_check 在節點上加鎖後先看它、寄成功（notify = sent）才寫入，所以同一台只會通知一次；
--                               不拿 replace_asked_at 當旗標，因為那個欄位的意思是「使用者回答了」，通知寄出不等於使用者回答。
--                               寄失敗（回傳 failed）不寫旗標，之後若又有機會被呼叫還能再試；限流另由 asn_relay_send_notice 以節點鍵再擋一道。
--   2. relay.device_replace_new_within()：新設備建立多久之內才問，現值 7 天，單一定義，要調只改這裡。
--   3. relay.device_replace_old_nodes(p_new)：給一台新節點，回傳它的候選舊設備（名稱用 relay.device_label、最後在線時間取
--      greatest(nodes.last_seen_at, asn_presence 最新回報)）。候選規則只在這一處：同帳號同租戶、同平台、啟用中、不是網頁、
--      不在帳號設定的 device_prefs.removed、目前不在線（最後上線早於 now() - relay.online_window()）、
--      而且最後上線早於新設備建立時間。通知、候選清單、取代三個入口都呼叫它。
--   4. relay.new_device_check(p_node)：自己冪等的觸發判斷（見上），條件符合就經 asn_relay_send_notice 寄一則 notice:new_device。
--      內文用 relay.device_label，不出代號、不出 email。
--   5. public.asn_relay_set_node_platform：只在 platform 由空變成有值的那一次呼叫 new_device_check；呼叫包在自己的 begin … exception 區塊，
--      通知出任何狀況都不會讓回報平台失敗（原有的行逐字不變）；出狀況時除了 warning，還寫一筆 account_events（new_device_check_failed）留底。
--   6. 三個給 Edge 用的函式（security definer、search_path 空、只授權 service_role）：
--        asn_device_replace_candidates(p_user, p_actor)         待回答的新設備與其候選舊設備
--        asn_device_replace(p_user, p_actor, p_new, p_old)      取代：單一交易，只能動本人名下的兩台
--        asn_device_replace_dismiss(p_user, p_actor, p_new)     不取代：只寫 replace_asked_at
-- 取代做的事：舊設備鍵加進 tenants.features->'device_prefs'.removed（rev 取「現在毫秒」與「現有 rev + 1」較大者，at 同步更新；
--   清單已滿 200 個時回 removed_full，不偷丟舊的）；新設備的名字換成舊設備的名字（舊設備沒有合格的名字就不搬）並標成本人取的；
--   舊設備保留原名；寫一筆 account_events（device_replaced）。重複呼叫不會再寫紀錄。
-- 部署順序：本 migration → relay（device_replace 三個動作）→ 用戶端（設定頁「設備處理」）。提早上不會壞：
--   舊用戶端不認得新通知種類時照一般通知顯示；沒有人呼叫新函式；set_node_platform 的回傳形狀不變。
-- 回復：supabase/sql/rollback/20261124210000_device_replace_down.sql（set_node_platform 換回上一版本體，drop 新函式與欄位）。
begin;

alter table relay.nodes add column if not exists replace_asked_at timestamptz;
alter table relay.nodes add column if not exists new_device_noticed_at timestamptz;

-- 新設備建立這麼久之內才問「是不是取代舊的」
create or replace function relay.device_replace_new_within()
 returns interval language sql immutable set search_path to ''
as $function$
  select interval '7 days'
$function$;

-- 一台新節點的候選舊設備
create or replace function relay.device_replace_old_nodes(p_new text)
 returns table (node text, label text, last_seen timestamptz)
 language sql
 stable
 set search_path to ''
as $function$
  select o.id, relay.device_label(o.id), s.last_seen
    from relay.nodes n
    join relay.nodes o on o.owner_user = n.owner_user and o.tenant_id is not distinct from n.tenant_id
    join relay.tenants t on t.id = n.tenant_id and t.owner_user = n.owner_user
    cross join lateral (
      select greatest(o.last_seen_at, (select max(p.updated_at) from relay.asn_presence p where p.node = o.id)) as last_seen
    ) s
   where n.id = p_new
     and n.status = 'active'
     and n.platform is not null
     and coalesce(n.kind, '') <> 'web'
     and o.id <> n.id
     and o.status = 'active'
     and o.platform = n.platform
     and coalesce(o.kind, '') <> 'web'
     and not coalesce(t.features -> 'device_prefs' -> 'removed' ? o.id, false)
     -- 目前不在線（在線門檻只有 relay.online_window() 一處定義）
     and coalesce(s.last_seen, '-infinity'::timestamptz) < now() - relay.online_window()
     -- 而且最後上線早於新設備建立：重灌時舊設備通常剛離線；剛睡著的電腦只要醒來一次（last_seen 晚於新設備建立）就自動排除
     and coalesce(s.last_seen, '-infinity'::timestamptz) < n.created_at
   order by s.last_seen desc nulls last, o.id;
$function$;

-- 新設備第一次回報平台之後的判斷：有候選舊設備才通知一次。自己冪等；不丟例外給呼叫端以外的人看（呼叫端另有 exception 區塊）
create or replace function relay.new_device_check(p_node text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  n relay.nodes%rowtype;
  v_what text;
  v_body text;
  v_res jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('new_device_check:' || coalesce(p_node, '')));
  select * into n from relay.nodes where id = p_node and status = 'active';
  if not found
     or n.platform is null
     or coalesce(n.kind, '') = 'web'
     or n.replace_asked_at is not null
     or n.new_device_noticed_at is not null
     or n.created_at <= now() - relay.device_replace_new_within()
     or n.owner_user is null
     or not public.asn_user_owns_node(n.owner_user, n.id) then
    return jsonb_build_object('ok', true, 'notify', 'skipped');
  end if;
  if not exists (select 1 from relay.device_replace_old_nodes(p_node)) then
    return jsonb_build_object('ok', true, 'notify', 'skipped');
  end if;
  v_what := case when n.platform in ('android', 'ios') then '手機' else '電腦' end;
  v_body := '有一台新的' || v_what || '連上了：' || relay.device_label(n.id) || '。它是用來取代舊設備的話，到設定 → 設備處理。';
  -- 同一個節點只通知一次：旗標在上面看、這裡寫；限流用節點鍵（7 天內最多 1 則）再擋一道
  v_res := public.asn_relay_send_notice(n.id, 'new_device', v_body, 1, relay.device_replace_new_within());
  if v_res is not null and v_res ->> 'notify' = 'sent' then
    update relay.nodes set new_device_noticed_at = now() where id = n.id;
  end if;
  return jsonb_build_object('ok', true, 'notify', coalesce(v_res ->> 'notify', 'failed'));
end;
$function$;
revoke all on function relay.device_replace_new_within() from public, anon, authenticated;
revoke all on function relay.device_replace_old_nodes(text) from public, anon, authenticated;
revoke all on function relay.new_device_check(text) from public, anon, authenticated;

-- 節點自己回報平台（上一版：20261102170000_node_platform_phone.sql；只多加「空變有值那次呼叫 new_device_check」，原有的行逐字不變）
create or replace function public.asn_relay_set_node_platform(p_node text, p_platform text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_prev text;
  v_found boolean;
  v_owner uuid;
begin
  if p_platform is null or p_platform not in ('linux', 'windows', 'macos', 'android', 'ios') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select platform into v_prev from relay.nodes where id = p_node and status = 'active' for update;
  v_found := found;
  update relay.nodes set platform = p_platform where id = p_node and status = 'active' and platform is distinct from p_platform;
  -- 只有「第一次回報平台」（空變有值）才問一次；通知出任何狀況都不能讓回報平台失敗
  if v_found and v_prev is null then
    begin
      perform relay.new_device_check(p_node);
    exception when others then
      raise warning 'new_device_check: node % failed: %', p_node, sqlerrm;
      -- 留一筆稽核，事後查得到；這筆寫入本身也不能讓回報平台失敗，節點沒有擁有者就不寫
      begin
        select owner_user into v_owner from relay.nodes where id = p_node;
        if v_owner is not null then
          insert into relay.account_events (user_id, event, node, detail)
            values (v_owner, 'new_device_check_failed', p_node, jsonb_build_object('error', sqlerrm));
        end if;
      exception when others then
        null;
      end;
    end;
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;
revoke all on function public.asn_relay_set_node_platform(text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_set_node_platform(text, text) to service_role;

-- 待回答的新設備與候選舊設備（名字用 device_label，不帶代號給畫面顯示用；node 鍵是給用戶端回呼用的）
create or replace function public.asn_device_replace_candidates(p_user uuid, p_actor text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
begin
  if p_user is null or p_actor is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not public.asn_user_owns_node(p_user, p_actor) then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('cards', coalesce((
    select jsonb_agg(jsonb_build_object(
        'node', n.id,
        'name', relay.device_label(n.id),
        'platform', n.platform,
        'created_at', n.created_at,
        'candidates', c.arr) order by n.created_at desc, n.id)
      from relay.nodes n
      cross join lateral (
        select jsonb_agg(jsonb_build_object('node', o.node, 'name', o.label, 'last_seen', o.last_seen) order by o.last_seen desc nulls last, o.node) as arr
          from relay.device_replace_old_nodes(n.id) o
      ) c
     where n.owner_user = p_user and n.status = 'active'
       and n.platform is not null and coalesce(n.kind, '') <> 'web'
       and n.replace_asked_at is null
       and n.created_at > now() - relay.device_replace_new_within()
       and c.arr is not null
       and public.asn_user_owns_node(p_user, n.id)
  ), '[]'::jsonb));
end;
$function$;
revoke all on function public.asn_device_replace_candidates(uuid, text) from public, anon, authenticated;
grant execute on function public.asn_device_replace_candidates(uuid, text) to service_role;

-- 取代：新設備接手舊設備的名字，舊設備從設備清單移除（只動本人名下的這兩台，單一交易）
create or replace function public.asn_device_replace(p_user uuid, p_actor text, p_new text, p_old text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  n relay.nodes%rowtype;
  v_t relay.tenants%rowtype;
  v_old_name text;
  v_prev_name text;
  v_cur jsonb;
  v_removed jsonb;
  v_new jsonb;
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_rev numeric;
  v_renamed boolean := false;
begin
  if p_user is null or p_actor is null or p_new is null or p_old is null or p_new = p_old
     or p_old !~ '^[A-Za-z0-9_-]{1,32}$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 送請求的設備與新、舊兩台都要是這個人的、啟用中（別人的、撤銷的、不存在一律 not_found，不洩漏是哪一種）
  if not public.asn_user_owns_node(p_user, p_actor)
     or not public.asn_user_owns_node(p_user, p_new)
     or not public.asn_user_owns_node(p_user, p_old) then
    return jsonb_build_object('error', 'not_found');
  end if;
  select * into n from relay.nodes where id = p_new and status = 'active' for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  select * into v_t from relay.tenants where id = n.tenant_id for update;
  v_cur := v_t.features -> 'device_prefs';
  if v_cur is not null and jsonb_typeof(v_cur) <> 'object' then
    v_cur := null;
  end if;
  v_removed := v_cur -> 'removed';
  if v_removed is null or jsonb_typeof(v_removed) <> 'array' then
    v_removed := '[]'::jsonb;
  end if;
  -- 已經回答過：舊的已在移除清單＝剛剛已經取代過了（重複呼叫），回 ok；否則是回答過「不取代」
  if n.replace_asked_at is not null then
    if v_removed ? p_old then
      return jsonb_build_object('ok', true, 'already', true);
    end if;
    return jsonb_build_object('error', 'answered');
  end if;
  -- 候選規則只有一份：同平台、目前離線且早於新設備建立、還沒被移除
  if not exists (select 1 from relay.device_replace_old_nodes(p_new) c where c.node = p_old) then
    return jsonb_build_object('error', 'not_candidate');
  end if;

  select name into v_old_name from relay.nodes where id = p_old;
  v_old_name := btrim(coalesce(v_old_name, ''));
  v_prev_name := n.name;

  -- 1. 舊設備鍵進移除清單（rev 要比現有的大，不然用戶端會當成舊資料）
  -- 移除清單上限 200（同 asn_account_device_prefs 的驗證）：滿了就回錯，不偷丟舊的（丟掉＝那台默默回到清單上）
  if jsonb_array_length(v_removed) >= 200 then
    return jsonb_build_object('error', 'removed_full');
  end if;
  v_removed := v_removed || to_jsonb(p_old);
  v_rev := greatest(v_now::numeric, coalesce((v_cur ->> 'rev')::numeric, 0) + 1);
  v_new := jsonb_build_object('order', coalesce(v_cur -> 'order', '[]'::jsonb), 'shown', coalesce(v_cur -> 'shown', '[]'::jsonb),
                              'removed', v_removed, 'rev', v_rev::bigint, 'at', v_now);
  update relay.tenants set features = coalesce(features, '{}'::jsonb) || jsonb_build_object('device_prefs', v_new) where id = v_t.id;

  -- 2. 新設備接手舊設備的名字（舊的沒有合格的名字就不搬）；舊設備保留原名
  if v_old_name <> '' and relay.device_name_ok(v_old_name) then
    update relay.nodes set name = v_old_name, name_by_owner = true, replace_asked_at = now() where id = p_new;
    update relay.room_members set display_name = v_old_name where member = p_new and display_name = v_prev_name;
    v_renamed := true;
  else
    update relay.nodes set replace_asked_at = now() where id = p_new;
  end if;

  insert into relay.account_events (user_id, event, node, detail)
    values (p_user, 'device_replaced', p_new,
            jsonb_build_object('old', p_old, 'new', p_new, 'by', p_actor, 'renamed', v_renamed));
  return jsonb_build_object('ok', true, 'already', false, 'renamed', v_renamed);
end;
$function$;
revoke all on function public.asn_device_replace(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.asn_device_replace(uuid, text, text, text) to service_role;

-- 不取代：兩台都留、不再問（只寫 replace_asked_at；重複呼叫不改時間）
create or replace function public.asn_device_replace_dismiss(p_user uuid, p_actor text, p_new text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if p_user is null or p_actor is null or p_new is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not public.asn_user_owns_node(p_user, p_actor) or not public.asn_user_owns_node(p_user, p_new) then
    return jsonb_build_object('error', 'not_found');
  end if;
  update relay.nodes set replace_asked_at = now() where id = p_new and status = 'active' and replace_asked_at is null;
  return jsonb_build_object('ok', true);
end;
$function$;
revoke all on function public.asn_device_replace_dismiss(uuid, text, text) from public, anon, authenticated;
grant execute on function public.asn_device_replace_dismiss(uuid, text, text) to service_role;

commit;
