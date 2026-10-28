CREATE OR REPLACE FUNCTION public.asn_relay_roster(p_node text, p_agents jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_n int;
  v_old jsonb;
  v_new jsonb;
  v_changed boolean;
  v_tenant uuid;
  v_topics jsonb := '[]'::jsonb;
begin
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active' and (can_invite or can_roster)) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_agents is null or jsonb_typeof(p_agents) <> 'array' or jsonb_array_length(p_agents) > 100 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_agents) a
    where jsonb_typeof(a) <> 'object' or jsonb_typeof(a->'name') is distinct from 'string'
       or char_length(a->>'name') not between 1 and 60
       or char_length(coalesce(a->>'status', '')) > 20 or char_length(coalesce(a->>'cwd_label', '')) > 80
  ) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select coalesce(jsonb_agg(jsonb_build_array(r.name, coalesce(r.status, ''), coalesce(r.detail, '')) order by r.name), '[]'::jsonb)
    into v_old from relay.roster r where r.node = p_node;
  delete from relay.roster where node = p_node;
  insert into relay.roster (node, name, status, cwd_label, engine, detail, context_pct, mod_loaded, kind, receivable, model, hidden)
    select distinct on (a.v->>'name') p_node, a.v->>'name', nullif(a.v->>'status', ''), nullif(a.v->>'cwd_label', ''),
           case when a.v->>'engine' ~ '^[a-z][a-z0-9_-]{0,19}$' then a.v->>'engine' end,
           case when jsonb_typeof(a.v->'detail') = 'string' then nullif(left(btrim(a.v->>'detail'), 80), '') end,
           case when jsonb_typeof(a.v->'context_pct') = 'number' and (a.v->>'context_pct')::numeric between 0 and 100 then round((a.v->>'context_pct')::numeric)::smallint end,
           case when jsonb_typeof(a.v->'mod_loaded') = 'boolean' then (a.v->>'mod_loaded')::boolean end,
           case when jsonb_typeof(a.v->'kind') = 'string' and a.v->>'kind' ~ '^[a-z][a-z0-9_-]{0,19}$' then a.v->>'kind' else 'window' end,
           case when jsonb_typeof(a.v->'receivable') = 'boolean' then (a.v->>'receivable')::boolean else true end,
           case when jsonb_typeof(a.v->'model') = 'string' then nullif(left(btrim(a.v->>'model'), 60), '') end,
           case when jsonb_typeof(a.v->'hidden') = 'boolean' then (a.v->>'hidden')::boolean end
    from jsonb_array_elements(p_agents) with ordinality as a(v, ord)
    order by a.v->>'name', a.ord desc;
  get diagnostics v_n = row_count;
  select coalesce(jsonb_agg(jsonb_build_array(r.name, coalesce(r.status, ''), coalesce(r.detail, '')) order by r.name), '[]'::jsonb)
    into v_new from relay.roster r where r.node = p_node;
  v_changed := v_old is distinct from v_new;
  if v_changed then
    update relay.nodes set roster_bell_at = now()
      where id = p_node and (roster_bell_at is null or roster_bell_at < now() - interval '2 seconds')
      returning tenant_id into v_tenant;
    if found then
      select coalesce(jsonb_agg(distinct o.bell_topic), '[]'::jsonb) into v_topics
        from relay.nodes o
        where o.id <> p_node and o.status = 'active' and o.bell_topic is not null
          and o.tenant_id is not distinct from v_tenant
          and o.last_seen_at > now() - interval '10 minutes';
    end if;
  end if;
  return jsonb_build_object('count', v_n, 'changed', v_changed, 'bell_topics', v_topics);
end;
$function$
