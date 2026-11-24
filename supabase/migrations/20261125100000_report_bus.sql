-- #2161 第 2a 段：回報匯流排後台（只新增，不碰任何舊路徑；不搬任何既有回報）。
-- 目的：各種「裝置狀態回報」（在線、名單、帳號、用量…）以 kind 區分，共用同一張表與同一組寫入／讀取函式；
--   新增一種 kind＝在 relay.report_kinds 加一列（宣告式 spec），不加 action、不加表；spec 表達不了的複雜 kind 才寫 relay.report_check_<kind>。
-- 內容：
--   1. relay.report_kinds（登記表）、relay.reports（最新值，主鍵 (node, kind)，節點刪除時連帶清掉）。兩張表啟用 RLS、不開任何 policy、收回權限。
--   2. 驗證：relay.report_check_value／report_check_spec（通用宣告式規格，未列欄位一律拒絕；預設擋疑似 email 與疑似金鑰）、relay.report_validate（查登記表、大小、spec、validator）。
--   （規格內欄位可用 allow_email／allow_secret 豁免第二道防線；UUID、32/40/64 位 hex、44 字元 base64 公鑰形狀預設不算金鑰。）
--   3. 寫入 public.asn_relay_report：雜湊去重、保活、伺服器端頻率限制（同節點同 kind 最小間隔；每節點滾動約 60 秒總量上限，數的是寫入次數、存 relay.report_rate）。不影響 nodes.last_seen_at。
--   4. 讀取 public.asn_relay_report_get ＋ relay.report_can_read／relay.report_readers（self／owner／room 三種範圍，同一份可見規則）。
--   5. 只登記一個測試用 kind：echo。
-- 事件型（mode='event'）只預留欄位與約定，本段不實作（事件不覆蓋最新值，之後另開單，避免各自寫各自的）。
-- 授權：函式一律 security definer、search_path 空；對外的 public.* 只授權 service_role；relay.* 內部函式只收回 public／anon／authenticated。
-- 回復：supabase/sql/rollback/20261125100000_report_bus_down.sql（drop 函式與兩張表）。
begin;

-- ===== 登記表 =====
create table if not exists relay.report_kinds (
  kind text primary key,
  mode text not null default 'snapshot' check (mode in ('snapshot', 'event')),
  spec jsonb,                       -- 宣告式規格（見 relay.report_check_spec）
  validator text,                   -- 可空；只有 spec 表達不了的才填，對應 relay.report_check_<kind>(jsonb) returns text（null＝通過）
  max_bytes int not null default 4096 check (max_bytes > 0),
  keepalive_seconds int not null default 300 check (keepalive_seconds >= 0),
  -- 下限 1 秒：最小間隔是單一 kind 的頻率限制，與每節點總量上限（relay.report_rate）互為雙保險；設 0 等於該 kind 沒有頻率限制，所以不准。
  min_interval_seconds int not null default 5 check (min_interval_seconds >= 1),
  read_scope text not null default 'self' check (read_scope in ('self', 'owner', 'room')),
  enabled boolean not null default true
);

-- ===== 最新值 =====
-- node 對 relay.nodes(id)（text 主鍵）外鍵，節點被刪時連帶清掉。
-- updated_at＝最後一次收到有效回報（含保活）；changed_at＝內容雜湊真的變了；written_at＝最後一次真正寫入（頻率限制用）。
create table if not exists relay.reports (
  node text not null references relay.nodes(id) on delete cascade,
  kind text not null,
  payload jsonb not null,
  hash text not null,
  size int not null,
  updated_at timestamptz not null default now(),
  changed_at timestamptz not null default now(),
  written_at timestamptz not null default now(),
  primary key (node, kind)
);
create index if not exists reports_node_written_idx on relay.reports (node, written_at);

-- 每節點寫入次數（每節點總量上限用）：10 秒一個桶，bucket = floor(epoch / 10)，n＝該桶內真正寫入的次數。
-- 不能用 reports 的列數算，因為主鍵是 (node, kind)，列數只代表「寫過幾種 kind」，不是「寫了幾次」。
create table if not exists relay.report_rate (
  node text not null references relay.nodes(id) on delete cascade,
  bucket bigint not null,
  n int not null default 0,
  primary key (node, bucket)
);

alter table relay.report_kinds enable row level security;
alter table relay.reports enable row level security;
alter table relay.report_rate enable row level security;
revoke all on relay.report_kinds from public, anon, authenticated;
revoke all on relay.reports from public, anon, authenticated;
revoke all on relay.report_rate from public, anon, authenticated;

-- ===== 通用規格檢查 =====
-- 回 null＝通過；否則回固定原因代碼（不回 payload 內容）：
--   bad_spec／too_deep／not_object／type_mismatch／unknown_field／missing_required／too_long／too_many／out_of_range／bad_enum／looks_like_email／looks_like_secret
create or replace function relay.report_check_value(p_def jsonb, p_val jsonb, p_allow text[], p_key text, p_depth int)
 returns text
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_type text;
  v_t text := jsonb_typeof(p_val);
  v_s text;
  v_n numeric;
  v_k text;
  v_r text;
  v_e jsonb;
  v_fields jsonb;
begin
  if p_depth > 6 then return 'too_deep'; end if;
  if jsonb_typeof(p_def) is distinct from 'object' then return 'bad_spec'; end if;
  v_type := p_def ->> 'type';
  if v_type = 'string' then
    if v_t is distinct from 'string' then return 'type_mismatch'; end if;
    v_s := p_val #>> '{}';
    if p_def ? 'max' and char_length(v_s) > (p_def ->> 'max')::numeric then return 'too_long'; end if;
    -- 第二道防線：疑似 email（含 @ 且像 x@y.z），只有 spec 明列 allow_email 的欄位才放行
    -- p_allow 的元素是「email:欄位名」或「secret:欄位名」（由 report_check_spec 從頂層 allow_email／allow_secret 陣列組出）
    if v_s ~ '[^\s@]+@[^\s@]+\.[^\s@]+'
       and not (coalesce((p_def ->> 'allow_email')::boolean, false) or ('email:' || p_key) = any (p_allow)) then
      return 'looks_like_email';
    end if;
    -- 疑似金鑰：長度 32 以上的連續英數／底線／減號／加號／等號片段，或 JWT、sk- 開頭。
    -- 整個字串剛好是下列常見的非機密形狀時，不算長片段（避免誤擋）：標準 UUID（8-4-4-4-12）、
    -- 純 hex 且長度恰為 32／40／64（MD5／SHA-1／SHA-256 形狀）、44 字元以 = 結尾的 base64（32 位元組公鑰形狀）。
    -- 取捨：這三種形狀的字串也可能真的是機密（例如 32 位元組的私鑰、64 位 hex 的金鑰）；規格層無從分辨，
    -- 所以只豁免「整串吻合」者，且金鑰欄位不該放進 payload；欄位明確要收長 token 時用 allow_secret 放行。
    -- JWT 與 sk- 開頭不豁免（除非 allow_secret）。
    if not (coalesce((p_def ->> 'allow_secret')::boolean, false) or ('secret:' || p_key) = any (p_allow)) then
      if (v_s ~ '[A-Za-z0-9_+=-]{32,}'
            and v_s !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
            and v_s !~ '^([0-9A-Fa-f]{32}|[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})$'
            and v_s !~ '^[A-Za-z0-9+/]{43}=$')
         or v_s ~ '^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.' or v_s ~ '^sk-[A-Za-z0-9_-]{8,}' then
        return 'looks_like_secret';
      end if;
    end if;
    return null;
  elsif v_type = 'int' or v_type = 'number' then
    if v_t is distinct from 'number' then return 'type_mismatch'; end if;
    v_n := (p_val #>> '{}')::numeric;
    if v_type = 'int' and v_n <> trunc(v_n) then return 'type_mismatch'; end if;
    if p_def ? 'min' and v_n < (p_def ->> 'min')::numeric then return 'out_of_range'; end if;
    if p_def ? 'max' and v_n > (p_def ->> 'max')::numeric then return 'out_of_range'; end if;
    return null;
  elsif v_type = 'bool' then
    if v_t is distinct from 'boolean' then return 'type_mismatch'; end if;
    return null;
  elsif v_type = 'enum' then
    if v_t is distinct from 'string' then return 'type_mismatch'; end if;
    if jsonb_typeof(p_def -> 'values') is distinct from 'array' then return 'bad_spec'; end if;
    if not exists (select 1 from jsonb_array_elements(p_def -> 'values') x where x = p_val) then return 'bad_enum'; end if;
    return null;
  elsif v_type = 'object' then
    if v_t is distinct from 'object' then return 'type_mismatch'; end if;
    v_fields := coalesce(p_def -> 'fields', '{}'::jsonb);
    if jsonb_typeof(v_fields) is distinct from 'object' then return 'bad_spec'; end if;
    for v_k in select jsonb_object_keys(p_val) loop
      if not (v_fields ? v_k) then return 'unknown_field'; end if;   -- 白名單：沒列的一律拒絕
      v_r := relay.report_check_value(v_fields -> v_k, p_val -> v_k, p_allow, v_k, p_depth + 1);
      if v_r is not null then return v_r; end if;
    end loop;
    if jsonb_typeof(p_def -> 'required') = 'array' then
      for v_k in select jsonb_array_elements_text(p_def -> 'required') loop
        if not (p_val ? v_k) then return 'missing_required'; end if;
      end loop;
    end if;
    return null;
  elsif v_type = 'array' then
    if v_t is distinct from 'array' then return 'type_mismatch'; end if;
    if jsonb_typeof(p_def -> 'of') is distinct from 'object' then return 'bad_spec'; end if;
    if p_def ? 'max' and jsonb_array_length(p_val) > (p_def ->> 'max')::numeric then return 'too_many'; end if;
    for v_e in select jsonb_array_elements(p_val) loop
      v_r := relay.report_check_value(p_def -> 'of', v_e, p_allow, p_key, p_depth + 1);
      if v_r is not null then return v_r; end if;
    end loop;
    return null;
  end if;
  return 'bad_spec';
end;
$function$;

create or replace function relay.report_check_spec(p_spec jsonb, p_payload jsonb)
 returns text
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_allow text[];
begin
  if jsonb_typeof(p_spec) is distinct from 'object' then return 'bad_spec'; end if;
  if jsonb_typeof(p_payload) is distinct from 'object' then return 'not_object'; end if;
  select coalesce(array_agg(x), array[]::text[]) into v_allow from (
    select 'email:' || e as x from jsonb_array_elements_text(case when jsonb_typeof(p_spec -> 'allow_email') = 'array' then p_spec -> 'allow_email' else '[]'::jsonb end) e
    union all
    select 'secret:' || e from jsonb_array_elements_text(case when jsonb_typeof(p_spec -> 'allow_secret') = 'array' then p_spec -> 'allow_secret' else '[]'::jsonb end) e
  ) a;
  return relay.report_check_value(
    jsonb_build_object('type', 'object', 'fields', coalesce(p_spec -> 'fields', '{}'::jsonb), 'required', coalesce(p_spec -> 'required', '[]'::jsonb)),
    p_payload, v_allow, null, 0);
end;
$function$;

-- ===== 驗證入口 =====
-- 回 null＝通過；否則 unknown_kind／disabled／not_object／too_large／no_rule／bad_validator／validator_error 或 spec／validator 回的代碼。
-- validator 只認 relay.report_check_<小寫英數底線>(jsonb) 且已存在的函式；名稱先過正規表示式才拼進 SQL（%I），避免注入。
create or replace function relay.report_validate(p_kind text, p_payload jsonb)
 returns text
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  k relay.report_kinds%rowtype;
  v_fn text;
  v_res text;
begin
  select * into k from relay.report_kinds where kind = p_kind;
  if not found then return 'unknown_kind'; end if;
  if not k.enabled then return 'disabled'; end if;
  if jsonb_typeof(p_payload) is distinct from 'object' then return 'not_object'; end if;
  if octet_length(p_payload::text) > k.max_bytes then return 'too_large'; end if;
  v_fn := nullif(btrim(k.validator), '');
  if k.spec is null and v_fn is null then return 'no_rule'; end if;
  if k.spec is not null then
    v_res := relay.report_check_spec(k.spec, p_payload);
    if v_res is not null then return v_res; end if;
  end if;
  if v_fn is not null then
    if v_fn !~ '^report_check_[a-z0-9_]+$' or to_regprocedure('relay.' || v_fn || '(jsonb)') is null then
      return 'bad_validator';
    end if;
    begin
      execute format('select relay.%I($1)', v_fn) into v_res using p_payload;
    exception when others then
      return 'validator_error';
    end;
    if v_res is not null then return v_res; end if;
  end if;
  return null;
end;
$function$;

-- ===== 寫入 =====
create or replace function public.asn_relay_report(p_node text, p_kind text, p_payload jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  c_node_cap constant int := 60;      -- 每節點滾動視窗內最多真正寫入幾次（見 relay.report_rate）（調整要改 migration）
  c_bucket constant int := 10;        -- 計數桶寬（秒）
  c_buckets constant int := 7;        -- 看最近 7 個桶（含目前桶）；近似：實際涵蓋 60～70 秒，邊界上最多多算 10 秒，偏保守（寧可早擋）
  k relay.report_kinds%rowtype;
  r relay.reports%rowtype;
  v_found boolean;
  v_why text;
  v_hash text;
  v_since_write numeric;
  v_cnt int;
  v_bucket bigint := floor(extract(epoch from now()) / 10);
  v_oldest bigint;
begin
  if p_node is null or p_kind is null or not exists (select 1 from relay.nodes where id = p_node and status = 'active') then
    return jsonb_build_object('ok', false, 'rejected_reason', 'not_found');
  end if;
  -- 同節點同 kind 序列化，避免併發各自判斷「間隔夠了」而雙寫
  perform pg_advisory_xact_lock(hashtext('report:' || p_node || ':' || p_kind));
  v_why := relay.report_validate(p_kind, p_payload);
  if v_why is not null then
    return jsonb_build_object('ok', false, 'rejected_reason', v_why);
  end if;
  select * into k from relay.report_kinds where kind = p_kind;
  v_hash := encode(sha256(convert_to(p_payload::text, 'utf8')), 'hex');   -- jsonb 的文字形式是正規化的（鍵排序、空白統一）
  select * into r from relay.reports where node = p_node and kind = p_kind;
  v_found := found;
  if v_found then
    v_since_write := extract(epoch from now() - r.written_at);
    if r.hash = v_hash then
      -- 內容沒變：未達保活，或距上次寫入還在最小間隔內 → 不寫
      if extract(epoch from now() - r.updated_at) < k.keepalive_seconds or v_since_write < k.min_interval_seconds then
        return jsonb_build_object('ok', true, 'changed', false);
      end if;
    elsif v_since_write < k.min_interval_seconds then
      -- 內容變了但還在最小間隔內：伺服器端擋（客戶端要保留最新值、間隔到了再送）
      return jsonb_build_object('ok', false, 'rejected_reason', 'rate', 'retry_after_seconds', ceil(k.min_interval_seconds - v_since_write)::int);
    end if;
  end if;
  -- 每節點總量上限：只在確定要真的寫入（新增、保活、內容變更）時才算；被拒絕或內容重複不寫的請求不計
  select coalesce(sum(n), 0), min(bucket) into v_cnt, v_oldest from relay.report_rate
    where node = p_node and bucket > v_bucket - c_buckets;
  if v_cnt >= c_node_cap then
    return jsonb_build_object('ok', false, 'rejected_reason', 'rate_node',
      'retry_after_seconds', greatest(1, ceil((v_oldest + c_buckets) * c_bucket - extract(epoch from now()))::int));
  end if;
  insert into relay.report_rate (node, bucket, n) values (p_node, v_bucket, 1)
    on conflict (node, bucket) do update set n = relay.report_rate.n + 1;
  delete from relay.report_rate where node = p_node and bucket <= v_bucket - c_buckets - 6;   -- 順手清自己的過期桶
  if not v_found then
    insert into relay.reports (node, kind, payload, hash, size, updated_at, changed_at, written_at)
      values (p_node, p_kind, p_payload, v_hash, octet_length(p_payload::text), now(), now(), now());
    return jsonb_build_object('ok', true, 'changed', true);
  elsif r.hash = v_hash then
    update relay.reports set updated_at = now(), written_at = now() where node = p_node and kind = p_kind;   -- 保活
    return jsonb_build_object('ok', true, 'changed', false);
  end if;
  update relay.reports set payload = p_payload, hash = v_hash, size = octet_length(p_payload::text),
      updated_at = now(), changed_at = now(), written_at = now()
    where node = p_node and kind = p_kind;
  return jsonb_build_object('ok', true, 'changed', true);
end;
$function$;

-- ===== 可見規則（唯一的一份；讀取與 report_readers 都走這裡）=====
-- caller 能不能讀 target 的回報。兩邊都必須是有效節點；自己永遠能讀自己。
--   owner：兩台都是同一位擁有者的（沿用 asn_user_owns_node：nodes.owner_user 與 tenants.owner_user 都是他、且 active）。
--   room ：同一租戶、同一個未封存群組、兩邊都是該群組現任成員（成員鍵＝節點，或「節點~視窗」）。群組建立地租戶也必須是同一租戶（最嚴；跨租戶的群組不互看）。
create or replace function relay.report_can_read(p_caller text, p_target text, p_scope text)
 returns boolean
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select p_caller is not null and p_target is not null
    and exists (select 1 from relay.nodes where id = p_caller and status = 'active')
    and exists (select 1 from relay.nodes where id = p_target and status = 'active')
    and (
      p_caller = p_target
      or (p_scope = 'owner' and exists (
        select 1 from relay.nodes c
        where c.id = p_caller and public.asn_user_owns_node(c.owner_user, p_caller) and public.asn_user_owns_node(c.owner_user, p_target)))
      or (p_scope = 'room' and exists (
        select 1
        from relay.nodes c
        join relay.nodes t on t.id = p_target and t.tenant_id = c.tenant_id
        join relay.rooms r on r.tenant_id = c.tenant_id and r.archived_at is null
        where c.id = p_caller
          and exists (select 1 from relay.room_members m where m.room_id = r.id and m.left_at is null
                        and (m.member = c.id or left(m.member, char_length(c.id) + 1) = c.id || '~'))
          and exists (select 1 from relay.room_members m where m.room_id = r.id and m.left_at is null
                        and (m.member = t.id or left(m.member, char_length(t.id) + 1) = t.id || '~'))))
    );
$function$;

-- 有權限讀「p_node 的 p_kind」的節點代號（含它自己；供 2b 發門鈴用）
create or replace function relay.report_readers(p_node text, p_kind text)
 returns setof text
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select n.id
  from relay.report_kinds k
  join relay.nodes t on t.id = p_node and t.status = 'active'
  join relay.nodes n on n.tenant_id = t.tenant_id and n.status = 'active'
  where k.kind = p_kind and k.enabled and relay.report_can_read(n.id, p_node, k.read_scope)
  order by n.id;
$function$;

-- ===== 讀取 =====
-- 沒權限的節點不出現在結果（不回錯誤，不洩漏存在與否）。p_nodes 最多 50 筆。
create or replace function public.asn_relay_report_get(p_caller text, p_kind text, p_nodes text[])
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  k relay.report_kinds%rowtype;
  v_out jsonb;
begin
  select * into k from relay.report_kinds where kind = p_kind and enabled;
  if not found then
    return jsonb_build_object('ok', false, 'rejected_reason', 'unknown_kind');
  end if;
  if p_nodes is not null and cardinality(p_nodes) > 50 then
    return jsonb_build_object('ok', false, 'rejected_reason', 'too_many_nodes');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('node', r.node, 'kind', r.kind, 'payload', r.payload,
      'updated_at', r.updated_at, 'changed_at', r.changed_at) order by r.node), '[]'::jsonb)
    into v_out
    from relay.reports r
    where r.kind = p_kind and r.node = any (coalesce(p_nodes, array[]::text[]))
      and relay.report_can_read(p_caller, r.node, k.read_scope);
  return jsonb_build_object('ok', true, 'reports', v_out);
end;
$function$;

-- ===== 授權 =====
revoke all on function relay.report_check_value(jsonb, jsonb, text[], text, int) from public, anon, authenticated;
revoke all on function relay.report_check_spec(jsonb, jsonb) from public, anon, authenticated;
revoke all on function relay.report_validate(text, jsonb) from public, anon, authenticated;
revoke all on function relay.report_can_read(text, text, text) from public, anon, authenticated;
revoke all on function relay.report_readers(text, text) from public, anon, authenticated;
revoke all on function public.asn_relay_report(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.asn_relay_report_get(text, text, text[]) from public, anon, authenticated;
grant execute on function public.asn_relay_report(text, text, jsonb) to service_role;
grant execute on function public.asn_relay_report_get(text, text, text[]) to service_role;

-- ===== 登記：只有測試用的 echo =====
insert into relay.report_kinds (kind, mode, spec, max_bytes, keepalive_seconds, min_interval_seconds, read_scope)
  values ('echo', 'snapshot', '{"fields":{"text":{"type":"string","max":200}},"required":["text"]}'::jsonb, 1024, 60, 5, 'self')
  on conflict (kind) do nothing;

commit;
