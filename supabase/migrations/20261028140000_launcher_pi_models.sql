-- #443／#444 第 2 步：啟動設定摘要多帶「這台 pi 能用的模型」（pi_models），手機與別台電腦的「切換模型」才有下拉選單。
-- 只多收一個選填欄位 pi_models：[{ provider, model }]，最多 200 筆；provider／model 只收 pi-models.mjs 的 SAFE 規則
-- （英數開頭，之後英數與 . _ : / @ + [ ] -，最長 100）。不合格的筆數丟掉，不整份拒收；pi_models 本身另限 24000 bytes，
-- 超過就只丟掉 pi_models、launcher 照常存（舊的 16000 bytes 上限只算 profiles／cwd_allow，行為不變）。
-- 不收憑證、路徑或其他設定。函式本體照正式庫現行定義（部署前已比對），只在檢查與存檔各加 pi_models 那一段。
-- 舊版用戶端只讀 launcher 的 profiles／cwd_allow／max_per_hour，多出來的欄位直接略過。部署順序：migration → relay 函式 → 用戶端。
begin;

create or replace function public.asn_relay_set_launcher(p_node text, p_launcher jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_pi jsonb;
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
    or octet_length((p_launcher - 'pi_models')::text) > 16000
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
          and (e->>'provider') ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,99}$'
          and (e->>'model') ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,99}$'
        order by o limit 200
      ) s;
    if v_pi is not null and octet_length(v_pi::text) > 24000 then
      v_pi := null;
    end if;
  end if;
  update relay.nodes set launcher = case when p_launcher is null then null else jsonb_build_object(
      'profiles', p_launcher->'profiles', 'cwd_allow', p_launcher->'cwd_allow',
      'max_per_hour', least(greatest(coalesce((p_launcher->>'max_per_hour')::int, 6), 1), 20))
      || case when v_pi is null then '{}'::jsonb else jsonb_build_object('pi_models', v_pi) end end,
    launcher_at = now()
  where id = p_node;
  return jsonb_build_object('ok', true);
end;
$function$;

commit;
