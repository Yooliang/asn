-- #2353 第②階段：啟動設定摘要多帶「各家 CLI 的型號清單」（models），手機與別台電腦才能看到這台能選的型號。
-- 規則（只寫規則）：
--   * models 是陣列，每一項是一家：{ vendor, status, stale?, code?, age_s?, models: [{ id, name }] }。
--   * vendor 符合 ^[a-z][a-z0-9-]{0,19}$，最多 8 家，同一家重複留先出現（且合格）的那筆。
--   * status 只收 ok／unavailable／error／pending；stale 只收布林；code 只收固定代碼（ok、not_installed、not_logged_in、
--     timeout、too_large、parse_failed、spawn_failed、unsupported）；age_s 只收 0～31536000 的整數。
--   * 型號代號 id 走統一規則 relay.valid_model_id（字元集＋以 / 切開後每一段不能是空字串、.、..）；name 1～80 字、不含控制字元與格式字元
--     （Unicode 的 Cc 與 Cf；Cf 的區間由 tools/gen-cf-ranges.mjs 產生，與 Edge 的 \p{Cf} 等價）；每家最多 200 筆。
--   * 不合格的整家（或那一筆）丟掉，其餘照存，不整份拒收。只收代號、顯示名、狀態與固定代碼，其餘欄位（含原因的原文）一律不收。
--   * models 不算進原本 16000 bytes 的上限；models 本身另限 32000 bytes（jsonb::text 的長度），超過只丟 models，launcher 照常存。
--   * pi_models 的代號也改用同一個規則函式（多了分段檢查）。
-- 舊版用戶端只讀 launcher 的 profiles／cwd_allow／max_per_hour／pi_models，多出來的欄位直接略過；舊電腦不送 models，輸出與以前完全相同。
-- 部署順序：migration → relay 函式 → 用戶端。部署前用 pg_get_functiondef 比對正式庫現行 asn_relay_set_launcher 是否仍是 20261028140000 的版本。
-- 退回：supabase/sql/rollback/20261126100000_launcher_models_down.sql
begin;

-- 統一型號規則（對照 relay/shared/test-vectors/model-id.json）。放 relay 結構描述，不對外露出
create or replace function relay.valid_model_id(p_id text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select coalesce(
    p_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,99}$'
    and p_id !~ '(^|/)\.{0,2}(/|$)',
    false);
$function$;
revoke all on function relay.valid_model_id(text) from public;

-- models 的整理：回整理後的陣列；不是陣列回 null
create or replace function relay.sanitize_launcher_models(p_models jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  r record;
  m record;
  v_out jsonb := '[]'::jsonb;
  v_seen text[] := '{}';
  v_list jsonb;
  v_n int;
  v_stale text; v_code text; v_age text; v_models text;
  v_o jsonb;
begin
  if p_models is null or jsonb_typeof(p_models) <> 'array' then
    return null;
  end if;
  for r in select e, o from jsonb_array_elements(p_models) with ordinality as t(e, o) order by o loop
    exit when jsonb_array_length(v_out) >= 8;
    continue when jsonb_typeof(r.e) is distinct from 'object';
    continue when jsonb_typeof(r.e->'vendor') is distinct from 'string'
               or (r.e->>'vendor') !~ '^[a-z][a-z0-9-]{0,19}$';
    continue when jsonb_typeof(r.e->'status') is distinct from 'string'
               or (r.e->>'status') not in ('ok', 'unavailable', 'error', 'pending');
    v_stale := jsonb_typeof(r.e->'stale');
    continue when v_stale is not null and v_stale not in ('null', 'boolean');
    v_code := jsonb_typeof(r.e->'code');
    continue when v_code is not null and v_code <> 'null' and (
         v_code <> 'string'
      or (r.e->>'code') not in ('ok', 'not_installed', 'not_logged_in', 'timeout', 'too_large', 'parse_failed', 'spawn_failed', 'unsupported'));
    v_age := jsonb_typeof(r.e->'age_s');
    continue when v_age is not null and v_age <> 'null' and (
         v_age <> 'number'
      or (r.e->>'age_s') !~ '^[0-9]{1,8}$'
      or (r.e->>'age_s')::bigint > 31536000);
    v_models := jsonb_typeof(r.e->'models');
    continue when v_models is not null and v_models not in ('null', 'array');
    continue when (r.e->>'vendor') = any(v_seen);

    v_list := '[]'::jsonb;
    v_n := 0;
    if v_models = 'array' then
      for m in select x from jsonb_array_elements(r.e->'models') with ordinality as t2(x, xo) order by xo loop
        exit when v_n >= 200;
        continue when jsonb_typeof(m.x) is distinct from 'object';
        continue when jsonb_typeof(m.x->'id') is distinct from 'string' or not relay.valid_model_id(m.x->>'id');
        continue when jsonb_typeof(m.x->'name') is distinct from 'string'
                   or char_length(m.x->>'name') not between 1 and 80
                   -- 控制字元（Cc）＋全部格式字元（Cf）。Cf 的區間由 tools/gen-cf-ranges.mjs 產生，勿手改；tests/launcher_models_sql.test.mjs 檢查最新一支 migration 的區間要涵蓋 Node 的 \p{Cf}，不夠時另寫新的 migration，不改已套用的檔
                   or (m.x->>'name') ~ '[\u0001-\u001f\u007f-\u009f\U000000ad\U00000600-\U00000605\U0000061c\U000006dd\U0000070f\U00000890-\U00000891\U000008e2\U0000180e\U0000200b-\U0000200f\U0000202a-\U0000202e\U00002060-\U00002064\U00002066-\U0000206f\U0000feff\U0000fff9-\U0000fffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f]';
        v_list := v_list || jsonb_build_array(jsonb_build_object('id', m.x->>'id', 'name', m.x->>'name'));
        v_n := v_n + 1;
      end loop;
    end if;

    v_o := jsonb_build_object('vendor', r.e->>'vendor', 'status', r.e->>'status');
    if v_stale = 'boolean' then v_o := v_o || jsonb_build_object('stale', r.e->'stale'); end if;
    if v_code = 'string' then v_o := v_o || jsonb_build_object('code', r.e->>'code'); end if;
    if v_age = 'number' then v_o := v_o || jsonb_build_object('age_s', (r.e->>'age_s')::bigint); end if;
    v_o := v_o || jsonb_build_object('models', v_list);
    v_out := v_out || jsonb_build_array(v_o);
    v_seen := v_seen || (r.e->>'vendor');
  end loop;
  return v_out;
end;
$function$;
revoke all on function relay.sanitize_launcher_models(jsonb) from public;

create or replace function public.asn_relay_set_launcher(p_node text, p_launcher jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_pi jsonb; v_models jsonb;
begin
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active' and (can_invite or can_roster)) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_launcher is not null and (
       jsonb_typeof(p_launcher) <> 'object'
    or jsonb_typeof(p_launcher->'profiles') is distinct from 'array'
    or jsonb_typeof(p_launcher->'cwd_allow') is distinct from 'array'
    or jsonb_array_length(p_launcher->'profiles') > 20
    or jsonb_array_length(p_launcher->'cwd_allow') > 50
    or octet_length((p_launcher - 'pi_models' - 'models')::text) > 16000
    or exists (select 1 from jsonb_array_elements(p_launcher->'profiles') p
               where jsonb_typeof(p->'id') is distinct from 'string' or char_length(p->>'id') not between 1 and 40
                  or char_length(coalesce(p->>'label', '')) > 60)
    or exists (select 1 from jsonb_array_elements(p_launcher->'cwd_allow') c
               where jsonb_typeof(c) <> 'string' or char_length(c #>> '{}') not between 1 and 260)
  ) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- pi_models：只留格式合格的 { provider, model }，最多 200 筆；沒有或不是陣列就不存
  if p_launcher is not null and jsonb_typeof(p_launcher->'pi_models') = 'array' then
    select jsonb_agg(jsonb_build_object('provider', e->>'provider', 'model', e->>'model') order by o) into v_pi
      from (
        select e, o from jsonb_array_elements(p_launcher->'pi_models') with ordinality as t(e, o)
        where jsonb_typeof(e) = 'object'
          and jsonb_typeof(e->'provider') = 'string' and jsonb_typeof(e->'model') = 'string'
          and relay.valid_model_id(e->>'provider')
          and relay.valid_model_id(e->>'model')
        order by o limit 200
      ) s;
    if v_pi is not null and octet_length(v_pi::text) > 24000 then
      v_pi := null;
    end if;
  end if;
  -- models：本身另限 32000 bytes（jsonb::text），超過只丟 models；不是陣列就不存
  if p_launcher is not null and jsonb_typeof(p_launcher->'models') = 'array'
     and octet_length((p_launcher->'models')::text) <= 32000 then
    v_models := relay.sanitize_launcher_models(p_launcher->'models');
  end if;
  update relay.nodes set launcher = case when p_launcher is null then null else jsonb_build_object(
      'profiles', p_launcher->'profiles', 'cwd_allow', p_launcher->'cwd_allow',
      'max_per_hour', least(greatest(coalesce((p_launcher->>'max_per_hour')::int, 6), 1), 20))
      || case when v_pi is null then '{}'::jsonb else jsonb_build_object('pi_models', v_pi) end
      || case when v_models is null then '{}'::jsonb else jsonb_build_object('models', v_models) end end,
    launcher_at = now()
  where id = p_node;
  return jsonb_build_object('ok', true);
end;
$function$;

commit;
