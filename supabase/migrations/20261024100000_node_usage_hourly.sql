-- 無頭節點每小時用量回報（設計見 docs/design/LINUX-HEADLESS.md）：每個節點每個整點一列，同鍵重送＝覆寫。
-- 內容：
--  1. relay.node_usage_hourly：主鍵 (node, hour)；七個計數欄位皆 bigint 非負。
--  2. public.asn_relay_usage_report(節點, 資料列 jsonb)：節點只能寫自己（Edge Function 以金鑰決定節點）；一次最多 48 筆；整批先檢查再寫，壞一筆整批不寫。
--  3. public.asn_relay_usage_list(節點, 起算時間, 筆數)：只讀自己的，新的在前，最多 200 筆。
-- 先不套用：部署順序為 migration → relay 函式 → 發新版 asn-cli（舊後台對新動作回 404，用戶端會看到 HTTP 404）。
-- 回復：drop function public.asn_relay_usage_report(text, jsonb); drop function public.asn_relay_usage_list(text, timestamptz, integer); drop table relay.node_usage_hourly;
begin;

create table if not exists relay.node_usage_hourly (
  node text not null,
  hour timestamptz not null,
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  cache_read_tokens bigint not null default 0 check (cache_read_tokens >= 0),
  cache_creation_tokens bigint not null default 0 check (cache_creation_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  tasks_ok bigint not null default 0 check (tasks_ok >= 0),
  tasks_failed bigint not null default 0 check (tasks_failed >= 0),
  rounds bigint not null default 0 check (rounds >= 0),
  updated_at timestamptz not null default now(),
  primary key (node, hour),
  check (hour = date_trunc('hour', hour))
);
alter table relay.node_usage_hourly enable row level security;
revoke all on relay.node_usage_hourly from public, anon, authenticated;

create or replace function public.asn_relay_usage_report(p_node text, p_rows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  r jsonb;
  f text;
  v_hour timestamptz;
  v_n integer := 0;
  v_fields text[] := array['input_tokens','cache_read_tokens','cache_creation_tokens','output_tokens','tasks_ok','tasks_failed','rounds'];
begin
  if p_node is null or not exists (select 1 from relay.nodes where id = p_node and status = 'active') then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 48 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  -- 先全部檢查再寫
  for r in select * from jsonb_array_elements(p_rows) loop
    if coalesce(jsonb_typeof(r), '') <> 'object' or coalesce(jsonb_typeof(r->'hour'), '') <> 'string' then
      return jsonb_build_object('error', 'bad_request');
    end if;
    begin
      v_hour := (r->>'hour')::timestamptz;
    exception when others then
      return jsonb_build_object('error', 'bad_request');
    end;
    if v_hour <> date_trunc('hour', v_hour) or v_hour < timestamptz '2020-01-01' or v_hour > now() + interval '1 hour' then
      return jsonb_build_object('error', 'bad_request');
    end if;
    foreach f in array v_fields loop
      if coalesce(jsonb_typeof(r->f), '') <> 'number' or (r->>f) !~ '^[0-9]{1,15}$' then
        return jsonb_build_object('error', 'bad_request');
      end if;
    end loop;
  end loop;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into relay.node_usage_hourly as u (node, hour, input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens, tasks_ok, tasks_failed, rounds, updated_at)
    values (p_node, (r->>'hour')::timestamptz, (r->>'input_tokens')::bigint, (r->>'cache_read_tokens')::bigint, (r->>'cache_creation_tokens')::bigint,
            (r->>'output_tokens')::bigint, (r->>'tasks_ok')::bigint, (r->>'tasks_failed')::bigint, (r->>'rounds')::bigint, now())
    on conflict (node, hour) do update set
      input_tokens = excluded.input_tokens, cache_read_tokens = excluded.cache_read_tokens, cache_creation_tokens = excluded.cache_creation_tokens,
      output_tokens = excluded.output_tokens, tasks_ok = excluded.tasks_ok, tasks_failed = excluded.tasks_failed, rounds = excluded.rounds, updated_at = now();
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'saved', v_n);
end;
$function$;
revoke all on function public.asn_relay_usage_report(text, jsonb) from public, anon, authenticated;
grant execute on function public.asn_relay_usage_report(text, jsonb) to service_role;

create or replace function public.asn_relay_usage_list(p_node text, p_since timestamptz, p_limit integer)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
begin
  if p_node is null or not exists (select 1 from relay.nodes where id = p_node and status = 'active') then
    return jsonb_build_object('error', 'forbidden');
  end if;
  return jsonb_build_object('rows', coalesce((
    select jsonb_agg(to_jsonb(t) order by t.hour desc) from (
      select to_char(u.hour at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as hour, u.node, u.input_tokens, u.cache_read_tokens, u.cache_creation_tokens,
             u.output_tokens, u.tasks_ok, u.tasks_failed, u.rounds
      from relay.node_usage_hourly u
      where u.node = p_node and (p_since is null or u.hour >= p_since)
      order by u.hour desc
      limit least(greatest(coalesce(p_limit, 200), 1), 200)
    ) t
  ), '[]'::jsonb));
end;
$function$;
revoke all on function public.asn_relay_usage_list(text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.asn_relay_usage_list(text, timestamptz, integer) to service_role;

commit;
