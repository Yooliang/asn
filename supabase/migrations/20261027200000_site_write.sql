-- 官網內容第二期（#400）：團隊節點用 asn-cli 寫入發版記錄、小會議記錄、藍圖與待辦項目，不再由維護者手下 SQL。
-- 內容：
--  1. relay.site_writers：可以寫官網內容的帳號（租戶）名單。這支 migration 不放任何一列——審查後由負責人自己加入擁有者的租戶：
--       insert into relay.site_writers (tenant_id, note) values ('<擁有者的租戶 id>', '專案負責人');
--     名單外的節點呼叫一律回 not_allowed。節點要是 active、租戶也要是 active。
--  2. relay.site_write_log：每次寫入記一筆（哪個節點、哪個動作、寫了哪一筆），只給維護者事後查；不公開（公開表不加節點欄位）。
--  3. 三支寫入函式（只給 service_role，由 relay Edge Function 帶金鑰所屬節點呼叫）：
--       public.asn_relay_site_meeting_add(節點, 會議 jsonb)：依 held_at 新增；同一時間已有記錄＝整筆覆寫（修正用）。
--       public.asn_relay_site_release_upsert(節點, 發版 jsonb)：依 version 新增或更新；更新時只改有帶的欄位。
--       public.asn_relay_site_item_upsert(節點, 項目 jsonb)：依 item_key 新增或更新藍圖／待辦項目；更新時只改有帶的欄位。
--     這一期不提供刪除；項目要下架就改 status（例如改成 released 並帶 version）。
--  4. 伺服器端檢查與資料表的限制一致（長度、版本格式、item_key 格式、欄位必須存在），另外不收：
--     HTML 標籤（頁面只用極小標記：**粗體**、`程式碼`、#123）、電子郵件、本機路徑、金鑰樣式（頁面是公開的）。
--  5. 頻率上限：同一個租戶每小時最多 120 次寫入。
-- 錯誤回 {"error": 代碼, "field": 欄位}：not_allowed、bad_request（field 指出哪一欄）、unsafe_content、bad_lane、missing_fields、rate_limited。
-- 先不套用：部署順序為 migration → 加入擁有者租戶 → relay 函式 → 下一版桌面版帶 asn-cli site（舊後台對新動作回 404）。
-- 回復：drop function public.asn_relay_site_meeting_add(text, jsonb); drop function public.asn_relay_site_release_upsert(text, jsonb);
--       drop function public.asn_relay_site_item_upsert(text, jsonb); drop function relay.site_writer_tenant(text, text);
--       drop function relay.site_text_ok(text, integer); drop function relay.site_text_array(jsonb, integer, integer, integer);
--       drop table relay.site_write_log; drop table relay.site_writers;
begin;

create table if not exists relay.site_writers (
  tenant_id uuid not null,
  note text,
  created_at timestamptz not null default now(),
  constraint site_writers_pkey primary key (tenant_id),
  constraint site_writers_tenant_fkey foreign key (tenant_id) references relay.tenants (id) on delete cascade,
  constraint site_writers_note_check check (note is null or char_length(note) <= 200)
);
comment on table relay.site_writers is '可以用 asn-cli site 寫官網內容（public.asn_site_*）的帳號（租戶）名單；由負責人手動維護。';
alter table relay.site_writers enable row level security;
revoke all on relay.site_writers from public, anon, authenticated;

create table if not exists relay.site_write_log (
  id bigint generated always as identity,
  at timestamptz not null default now(),
  node text not null,
  tenant_id uuid not null,
  action text not null,
  target text not null,
  constraint site_write_log_pkey primary key (id)
);
create index if not exists site_write_log_tenant_at_idx on relay.site_write_log (tenant_id, at);
comment on table relay.site_write_log is '官網內容寫入記錄（不公開）：哪個節點、哪個動作（meeting／release／item）、寫了哪一筆（held_at／version／item_key）。';
alter table relay.site_write_log enable row level security;
revoke all on relay.site_write_log from public, anon, authenticated;

-- 名單檢查：節點 active、租戶 active 且在名單上、這個租戶一小時內寫入不到 120 次。通過回租戶 id；不通過回 null，p_err 說原因
create or replace function relay.site_writer_tenant(p_node text, out p_tenant uuid, out p_err text)
 language plpgsql
 stable
 set search_path to ''
as $function$
begin
  select n.tenant_id into p_tenant
  from relay.nodes n
  join relay.tenants t on t.id = n.tenant_id and t.status = 'active'
  join relay.site_writers w on w.tenant_id = n.tenant_id
  where n.id = p_node and n.status = 'active';
  if p_tenant is null then
    p_err := 'not_allowed';
    return;
  end if;
  if (select count(*) from relay.site_write_log l where l.tenant_id = p_tenant and l.at > now() - interval '1 hour') >= 120 then
    p_tenant := null;
    p_err := 'rate_limited';
  end if;
end;
$function$;

-- 一段公開文字可不可以收：非空白、長度 1～上限、沒有控制字元（換行、tab 可以）、沒有 HTML 標籤、電子郵件、本機路徑、金鑰樣式。
-- 回 'ok'、'bad'（長度或格式不對）、'unsafe'（內容不能公開）
create or replace function relay.site_text_ok(p text, p_max integer)
 returns text
 language sql
 immutable
 set search_path to ''
as $function$
  select case
    when p is null or btrim(p) = '' or char_length(p) > p_max then 'bad'
    when p ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then 'bad'
    when p ~ '<\s*/?\s*[A-Za-z!?]' then 'unsafe'
    when p ~ '[A-Za-z0-9_.+-]+@[A-Za-z0-9_-]+\.[A-Za-z0-9_.]+' then 'unsafe'
    when p ~ '[A-Za-z]:\\|/home/|/Users/|~/\.' then 'unsafe'
    when p ~ 'eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|service_role' then 'unsafe'
    else 'ok'
  end
$function$;

-- jsonb 字串陣列 → text[]：p_min～p_max 個元素，每個元素都要通過 site_text_ok。格式不對回 null；內容不能公開回 '{__unsafe__}'
create or replace function relay.site_text_array(p jsonb, p_min integer, p_max integer, p_len integer)
 returns text[]
 language plpgsql
 immutable
 set search_path to ''
as $function$
declare
  e jsonb;
  v text;
  out_arr text[] := '{}';
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) < p_min or jsonb_array_length(p) > p_max then
    return null;
  end if;
  for e in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(e) <> 'string' then
      return null;
    end if;
    v := e #>> '{}';
    case relay.site_text_ok(v, p_len)
      when 'ok' then out_arr := out_arr || v;
      when 'unsafe' then return array['__unsafe__'];
      else return null;
    end case;
  end loop;
  return out_arr;
end;
$function$;

revoke all on function relay.site_writer_tenant(text) from public, anon, authenticated;
revoke all on function relay.site_text_ok(text, integer) from public, anon, authenticated;
revoke all on function relay.site_text_array(jsonb, integer, integer, integer) from public, anon, authenticated;

-- 小會議記錄：held_at（ISO 時間，含時區）與五個字串陣列（每項 1～2000 字、1～30 項，沒內容寫「無」）。同一時間已有＝整筆覆寫
create or replace function public.asn_relay_site_meeting_add(p_node text, p_meeting jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_tenant uuid;
  v_err text;
  v_at timestamptz;
  v_id bigint;
  v_created boolean;
  f text;
  v_arr text[];
  v_attendees text[]; v_progress text[]; v_decisions text[]; v_assignments text[]; v_improvements text[];
begin
  select w.p_tenant, w.p_err into v_tenant, v_err from relay.site_writer_tenant(p_node) w;
  if v_tenant is null then
    return jsonb_build_object('error', v_err);
  end if;
  if p_meeting is null or jsonb_typeof(p_meeting) <> 'object' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if coalesce(jsonb_typeof(p_meeting->'held_at'), '') <> 'string' or char_length(p_meeting->>'held_at') > 40
     or (p_meeting->>'held_at') !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$' then
    return jsonb_build_object('error', 'bad_request', 'field', 'held_at');
  end if;
  begin
    v_at := (p_meeting->>'held_at')::timestamptz;
  exception when others then
    return jsonb_build_object('error', 'bad_request', 'field', 'held_at');
  end;
  if v_at < timestamptz '2026-01-01' or v_at > now() + interval '7 days' then
    return jsonb_build_object('error', 'bad_request', 'field', 'held_at');
  end if;
  foreach f in array array['attendees', 'progress', 'decisions', 'assignments', 'improvements'] loop
    v_arr := relay.site_text_array(p_meeting->f, 1, 30, 2000);
    if v_arr is null then
      return jsonb_build_object('error', 'bad_request', 'field', f);
    end if;
    if v_arr = array['__unsafe__'] then
      return jsonb_build_object('error', 'unsafe_content', 'field', f);
    end if;
    case f
      when 'attendees' then v_attendees := v_arr;
      when 'progress' then v_progress := v_arr;
      when 'decisions' then v_decisions := v_arr;
      when 'assignments' then v_assignments := v_arr;
      else v_improvements := v_arr;
    end case;
  end loop;

  select m.id into v_id from public.asn_site_meetings m where m.held_at = v_at;
  v_created := v_id is null;
  if v_created then
    insert into public.asn_site_meetings (held_at, attendees, progress, decisions, assignments, improvements)
    values (v_at, v_attendees, v_progress, v_decisions, v_assignments, v_improvements)
    returning id into v_id;
  else
    update public.asn_site_meetings set attendees = v_attendees, progress = v_progress, decisions = v_decisions,
      assignments = v_assignments, improvements = v_improvements, updated_at = now()
    where id = v_id;
  end if;
  insert into relay.site_write_log (node, tenant_id, action, target) values (p_node, v_tenant, 'meeting', v_at::text);
  return jsonb_build_object('ok', true, 'id', v_id, 'created', v_created);
end;
$function$;
revoke all on function public.asn_relay_site_meeting_add(text, jsonb) from public, anon, authenticated;
grant execute on function public.asn_relay_site_meeting_add(text, jsonb) to service_role;

-- 發版：version（x.y.z）必填。新增時 released_on（YYYY-MM-DD）與 items（1～30 項、每項 1～1000 字）必填；
-- platforms（0～10 項、每項 1～20 字）、commit_sha（7～40 碼小寫十六進位）、notes（1～2000 字）選填，帶 null 或空字串＝清掉。更新時沒帶的欄位不動
create or replace function public.asn_relay_site_release_upsert(p_node text, p_release jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_tenant uuid;
  v_err text;
  v_version text;
  v_exists boolean;
  v_on date;
  v_items text[];
  v_platforms text[];
  v_commit text;
  v_notes text;
  v_chk text;
begin
  select w.p_tenant, w.p_err into v_tenant, v_err from relay.site_writer_tenant(p_node) w;
  if v_tenant is null then
    return jsonb_build_object('error', v_err);
  end if;
  if p_release is null or jsonb_typeof(p_release) <> 'object' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  v_version := p_release->>'version';
  if coalesce(jsonb_typeof(p_release->'version'), '') <> 'string' or v_version !~ '^\d{1,4}\.\d{1,4}\.\d{1,4}$' then
    return jsonb_build_object('error', 'bad_request', 'field', 'version');
  end if;
  v_exists := exists (select 1 from public.asn_site_releases r where r.version = v_version);

  if p_release ? 'released_on' then
    if coalesce(jsonb_typeof(p_release->'released_on'), '') <> 'string' or (p_release->>'released_on') !~ '^\d{4}-\d{2}-\d{2}$' then
      return jsonb_build_object('error', 'bad_request', 'field', 'released_on');
    end if;
    begin
      v_on := (p_release->>'released_on')::date;
    exception when others then
      return jsonb_build_object('error', 'bad_request', 'field', 'released_on');
    end;
    if v_on < date '2026-01-01' or v_on > current_date + 7 then
      return jsonb_build_object('error', 'bad_request', 'field', 'released_on');
    end if;
  end if;
  if p_release ? 'items' then
    v_items := relay.site_text_array(p_release->'items', 1, 30, 1000);
    if v_items is null then return jsonb_build_object('error', 'bad_request', 'field', 'items'); end if;
    if v_items = array['__unsafe__'] then return jsonb_build_object('error', 'unsafe_content', 'field', 'items'); end if;
  end if;
  if p_release ? 'platforms' and jsonb_typeof(p_release->'platforms') <> 'null' then
    v_platforms := relay.site_text_array(p_release->'platforms', 0, 10, 20);
    if v_platforms is null then return jsonb_build_object('error', 'bad_request', 'field', 'platforms'); end if;
    if v_platforms = array['__unsafe__'] then return jsonb_build_object('error', 'unsafe_content', 'field', 'platforms'); end if;
  end if;
  if p_release ? 'commit_sha' and coalesce(p_release->>'commit_sha', '') <> '' then
    v_commit := p_release->>'commit_sha';
    if jsonb_typeof(p_release->'commit_sha') <> 'string' or v_commit !~ '^[0-9a-f]{7,40}$' then
      return jsonb_build_object('error', 'bad_request', 'field', 'commit_sha');
    end if;
  end if;
  if p_release ? 'notes' and coalesce(p_release->>'notes', '') <> '' then
    v_notes := p_release->>'notes';
    if jsonb_typeof(p_release->'notes') <> 'string' then return jsonb_build_object('error', 'bad_request', 'field', 'notes'); end if;
    v_chk := relay.site_text_ok(v_notes, 2000);
    if v_chk = 'unsafe' then return jsonb_build_object('error', 'unsafe_content', 'field', 'notes'); end if;
    if v_chk <> 'ok' then return jsonb_build_object('error', 'bad_request', 'field', 'notes'); end if;
  end if;

  if not v_exists then
    if v_on is null or v_items is null then
      return jsonb_build_object('error', 'missing_fields', 'field', case when v_on is null then 'released_on' else 'items' end);
    end if;
    insert into public.asn_site_releases (version, released_on, items, platforms, commit_sha, notes)
    values (v_version, v_on, v_items, coalesce(v_platforms, '{}'), v_commit, v_notes);
  else
    update public.asn_site_releases r set
      released_on = case when p_release ? 'released_on' then v_on else r.released_on end,
      items = case when p_release ? 'items' then v_items else r.items end,
      platforms = case when p_release ? 'platforms' then coalesce(v_platforms, '{}') else r.platforms end,
      commit_sha = case when p_release ? 'commit_sha' then v_commit else r.commit_sha end,
      notes = case when p_release ? 'notes' then v_notes else r.notes end,
      updated_at = now()
    where r.version = v_version;
  end if;
  insert into relay.site_write_log (node, tenant_id, action, target) values (p_node, v_tenant, 'release', v_version);
  return jsonb_build_object('ok', true, 'version', v_version, 'created', not v_exists);
end;
$function$;
revoke all on function public.asn_relay_site_release_upsert(text, jsonb) from public, anon, authenticated;
grant execute on function public.asn_relay_site_release_upsert(text, jsonb) to service_role;

-- 藍圖／待辦項目：item_key 必填。新增時 section＋lane（必須是已存在的欄位）、body、status 必填；
-- title（1～80 字，null 或空字串＝不要標題）、refs（議題編號，最多 30 個正整數）、version（x.y.z，null 或空字串＝清掉）、sort_order（0～1000000，省略＝排在該欄最後）選填。
-- 更新時沒帶的欄位不動；換欄位要同時帶 section 與 lane
create or replace function public.asn_relay_site_item_upsert(p_node text, p_item jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_tenant uuid;
  v_err text;
  v_key text;
  v_old public.asn_site_roadmap_items;
  v_section text;
  v_lane text;
  v_title text;
  v_body text;
  v_refs integer[];
  v_status text;
  v_version text;
  v_sort integer;
  v_chk text;
  e jsonb;
begin
  select w.p_tenant, w.p_err into v_tenant, v_err from relay.site_writer_tenant(p_node) w;
  if v_tenant is null then
    return jsonb_build_object('error', v_err);
  end if;
  if p_item is null or jsonb_typeof(p_item) <> 'object' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  v_key := p_item->>'item_key';
  if coalesce(jsonb_typeof(p_item->'item_key'), '') <> 'string' or v_key !~ '^[a-z0-9][a-z0-9-]{0,60}$' then
    return jsonb_build_object('error', 'bad_request', 'field', 'item_key');
  end if;
  select * into v_old from public.asn_site_roadmap_items i where i.item_key = v_key;

  if (p_item ? 'section') <> (p_item ? 'lane') then
    return jsonb_build_object('error', 'bad_request', 'field', case when p_item ? 'section' then 'lane' else 'section' end);
  end if;
  if p_item ? 'section' then
    v_section := p_item->>'section';
    v_lane := p_item->>'lane';
    if coalesce(jsonb_typeof(p_item->'section'), '') <> 'string' or v_section not in ('roadmap', 'todo') then
      return jsonb_build_object('error', 'bad_request', 'field', 'section');
    end if;
    if coalesce(jsonb_typeof(p_item->'lane'), '') <> 'string' or v_lane !~ '^[a-z][a-z0-9-]{0,30}$' then
      return jsonb_build_object('error', 'bad_request', 'field', 'lane');
    end if;
    if not exists (select 1 from public.asn_site_lanes l where l.section = v_section and l.lane = v_lane) then
      return jsonb_build_object('error', 'bad_lane', 'field', 'lane');
    end if;
  end if;
  if p_item ? 'title' and coalesce(p_item->>'title', '') <> '' then
    if jsonb_typeof(p_item->'title') <> 'string' then return jsonb_build_object('error', 'bad_request', 'field', 'title'); end if;
    v_title := p_item->>'title';
    v_chk := relay.site_text_ok(v_title, 80);
    if v_chk = 'unsafe' then return jsonb_build_object('error', 'unsafe_content', 'field', 'title'); end if;
    if v_chk <> 'ok' or v_title ~ '\n' then return jsonb_build_object('error', 'bad_request', 'field', 'title'); end if;
  end if;
  if p_item ? 'body' then
    if coalesce(jsonb_typeof(p_item->'body'), '') <> 'string' then return jsonb_build_object('error', 'bad_request', 'field', 'body'); end if;
    v_body := p_item->>'body';
    v_chk := relay.site_text_ok(v_body, 4000);
    if v_chk = 'unsafe' then return jsonb_build_object('error', 'unsafe_content', 'field', 'body'); end if;
    if v_chk <> 'ok' then return jsonb_build_object('error', 'bad_request', 'field', 'body'); end if;
  end if;
  if p_item ? 'refs' then
    if jsonb_typeof(p_item->'refs') <> 'array' or jsonb_array_length(p_item->'refs') > 30 then
      return jsonb_build_object('error', 'bad_request', 'field', 'refs');
    end if;
    v_refs := '{}';
    for e in select * from jsonb_array_elements(p_item->'refs') loop
      if jsonb_typeof(e) <> 'number' or (e #>> '{}') !~ '^[1-9][0-9]{0,8}$' then
        return jsonb_build_object('error', 'bad_request', 'field', 'refs');
      end if;
      if not ((e #>> '{}')::integer = any (v_refs)) then
        v_refs := v_refs || (e #>> '{}')::integer;
      end if;
    end loop;
  end if;
  if p_item ? 'status' then
    v_status := p_item->>'status';
    if coalesce(jsonb_typeof(p_item->'status'), '') <> 'string' or v_status not in ('released', 'doing', 'planned', 'decide') then
      return jsonb_build_object('error', 'bad_request', 'field', 'status');
    end if;
  end if;
  if p_item ? 'version' and coalesce(p_item->>'version', '') <> '' then
    v_version := p_item->>'version';
    if jsonb_typeof(p_item->'version') <> 'string' or v_version !~ '^\d{1,4}\.\d{1,4}\.\d{1,4}$' then
      return jsonb_build_object('error', 'bad_request', 'field', 'version');
    end if;
  end if;
  if p_item ? 'sort_order' then
    if jsonb_typeof(p_item->'sort_order') <> 'number' or (p_item->>'sort_order') !~ '^[0-9]{1,7}$' or (p_item->>'sort_order')::integer > 1000000 then
      return jsonb_build_object('error', 'bad_request', 'field', 'sort_order');
    end if;
    v_sort := (p_item->>'sort_order')::integer;
  end if;

  if v_old.id is null then
    if v_section is null or v_body is null or v_status is null then
      return jsonb_build_object('error', 'missing_fields', 'field',
        case when v_section is null then 'section' when v_body is null then 'body' else 'status' end);
    end if;
    if v_sort is null then
      select coalesce(max(i.sort_order), 0) + 10 into v_sort from public.asn_site_roadmap_items i where i.section = v_section and i.lane = v_lane;
    end if;
    insert into public.asn_site_roadmap_items (item_key, section, lane, title, body, refs, status, version, sort_order)
    values (v_key, v_section, v_lane, v_title, v_body, coalesce(v_refs, '{}'), v_status, v_version, v_sort);
  else
    if v_sort is null and v_section is not null and (v_section, v_lane) is distinct from (v_old.section, v_old.lane) then
      select coalesce(max(i.sort_order), 0) + 10 into v_sort from public.asn_site_roadmap_items i where i.section = v_section and i.lane = v_lane;
    end if;
    update public.asn_site_roadmap_items i set
      section = coalesce(v_section, i.section),
      lane = coalesce(v_lane, i.lane),
      title = case when p_item ? 'title' then v_title else i.title end,
      body = coalesce(v_body, i.body),
      refs = coalesce(v_refs, i.refs),
      status = coalesce(v_status, i.status),
      version = case when p_item ? 'version' then v_version else i.version end,
      sort_order = coalesce(v_sort, i.sort_order),
      updated_at = now()
    where i.id = v_old.id;
  end if;
  insert into relay.site_write_log (node, tenant_id, action, target) values (p_node, v_tenant, 'item', v_key);
  return jsonb_build_object('ok', true, 'item_key', v_key, 'created', v_old.id is null);
end;
$function$;
revoke all on function public.asn_relay_site_item_upsert(text, jsonb) from public, anon, authenticated;
grant execute on function public.asn_relay_site_item_upsert(text, jsonb) to service_role;

commit;
