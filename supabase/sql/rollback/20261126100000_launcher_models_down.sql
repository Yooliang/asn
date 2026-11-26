-- 退回 20261126100000_launcher_models.sql：asn_relay_set_launcher 還原成 20261028140000 的版本，並拿掉兩支新函式。
-- 已存在 relay.nodes.launcher 裡的 models 欄位不動（舊版函式與用戶端會直接略過它，下一次回報時被覆蓋）。
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

drop function if exists relay.sanitize_launcher_models(jsonb);
drop function if exists relay.valid_model_id(text);

commit;
