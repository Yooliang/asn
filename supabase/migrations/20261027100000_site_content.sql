-- 官網內容搬進資料庫（第一期）：藍圖頁（/roadmap）與開發日誌頁（/log）的內容改從這幾張表讀。
-- 之前這些內容寫死在 site/public/roadmap.html、site/meetings.json，每次發版都要開 PR 改頁面，常常落後主線。
-- 設計：
--   * 全部是公開內容，任何人（anon）都能讀；anon／authenticated 不能新增、修改、刪除。
--   * 第一期由維護者直接下 SQL 寫入（service role／資料庫擁有者）；第二期會改走 relay Edge Function，帶節點簽章，並提供 asn-cli 指令。
--   * 內文不存 HTML：只用極小的標記——**粗體**、`程式碼`、#123（議題編號，只是文字樣式），以換行開頭的「- 」行是子項目。
--     頁面一律用 textContent 建節點，不會把資料庫內容當 HTML 插進頁面。
--   * 頁面是公開的：不要寫電子郵件、本機路徑或金鑰。
-- 種子資料在下一個 migration（20261027100100_site_content_seed.sql，由 site/tools/extract-roadmap-seed.mjs 產生）。
-- 回復：drop 這七張表。
begin;

-- 發版：一版一列
create table if not exists public.asn_site_releases (
  version text not null,
  released_on date not null,
  items text[] not null default '{}',
  platforms text[] not null default '{}',
  commit_sha text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint asn_site_releases_pkey primary key (version),
  constraint asn_site_releases_version_check check (version ~ '^\d+\.\d+\.\d+$'),
  constraint asn_site_releases_items_check check (cardinality(items) between 1 and 30),
  constraint asn_site_releases_platforms_check check (cardinality(platforms) <= 10),
  constraint asn_site_releases_commit_check check (commit_sha is null or commit_sha ~ '^[0-9a-f]{7,40}$'),
  constraint asn_site_releases_notes_check check (notes is null or char_length(notes) <= 2000)
);
comment on table public.asn_site_releases is '官網發版記錄（公開）。items：這版的更新說明條列（內文格式見 migration 開頭）；platforms：發佈到哪裡（官網、Play、家用機…）；commit_sha：發版 commit 短碼；notes：補充說明。';

-- 小會議記錄：一場一列；五個欄位都是字串陣列（一項一個元素），沒內容寫「無」
create table if not exists public.asn_site_meetings (
  id bigint generated always as identity,
  held_at timestamptz not null,
  attendees text[] not null,
  progress text[] not null,
  decisions text[] not null,
  assignments text[] not null,
  improvements text[] not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint asn_site_meetings_pkey primary key (id),
  constraint asn_site_meetings_held_at_key unique (held_at),
  constraint asn_site_meetings_fields_check check (
    cardinality(attendees) between 1 and 30 and cardinality(progress) between 1 and 30 and cardinality(decisions) between 1 and 30
    and cardinality(assignments) between 1 and 30 and cardinality(improvements) between 1 and 30)
);
comment on table public.asn_site_meetings is '小會議記錄（公開）。held_at 存時間點，頁面以台北時間顯示；attendees 出席／回覆、progress 各項進度、decisions 決議、assignments 分派、improvements 改善意見。';

-- 藍圖與待辦的欄位（藍圖：已完成／進行中／規劃中；待辦：需要負責人決定／近期／之後）
create table if not exists public.asn_site_lanes (
  section text not null,
  lane text not null,
  label text not null,
  tone text not null,
  sort_order integer not null,
  constraint asn_site_lanes_pkey primary key (section, lane),
  constraint asn_site_lanes_section_check check (section = any (array['roadmap', 'todo'])),
  constraint asn_site_lanes_lane_check check (lane ~ '^[a-z][a-z0-9-]{0,30}$'),
  constraint asn_site_lanes_label_check check (char_length(label) between 1 and 40),
  constraint asn_site_lanes_tone_check check (tone = any (array['done', 'doing', 'plan']))
);
comment on table public.asn_site_lanes is '藍圖（section=roadmap）與待辦（section=todo）的欄位；tone 是標籤顏色（done 綠、doing 藍、plan 黃）。';

-- 藍圖與待辦的項目
create table if not exists public.asn_site_roadmap_items (
  id bigint generated always as identity,
  item_key text not null,
  section text not null,
  lane text not null,
  title text,
  body text not null,
  refs integer[] not null default '{}',
  status text not null,
  version text,
  sort_order integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint asn_site_roadmap_items_pkey primary key (id),
  constraint asn_site_roadmap_items_key unique (item_key),
  constraint asn_site_roadmap_items_lane_fkey foreign key (section, lane) references public.asn_site_lanes (section, lane),
  constraint asn_site_roadmap_items_key_check check (item_key ~ '^[a-z0-9][a-z0-9-]{0,60}$'),
  constraint asn_site_roadmap_items_title_check check (title is null or char_length(title) between 1 and 80),
  constraint asn_site_roadmap_items_body_check check (char_length(body) between 1 and 4000),
  constraint asn_site_roadmap_items_refs_check check (cardinality(refs) <= 30 and 0 < all (refs)),
  constraint asn_site_roadmap_items_status_check check (status = any (array['released', 'doing', 'planned', 'decide'])),
  constraint asn_site_roadmap_items_version_check check (version is null or version ~ '^\d+\.\d+\.\d+$')
);
create index if not exists asn_site_roadmap_items_lane_idx on public.asn_site_roadmap_items (section, lane, sort_order);
comment on table public.asn_site_roadmap_items is '藍圖與待辦的項目（公開）。refs：相關議題／PR 編號；status：released 已發佈、doing 進行中、planned 規劃中、decide 等負責人決定；version：綁定的版本（已隨某版發佈、或預定在某版）；藍圖頁時間軸依 status 與 version 排在過去、現在或未來。';

-- 各家 AI 支援總表：欄（功能）、列（AI）、格（狀態＋說明）
create table if not exists public.asn_site_matrix_columns (
  column_key text not null,
  label text not null,
  sort_order integer not null,
  constraint asn_site_matrix_columns_pkey primary key (column_key),
  constraint asn_site_matrix_columns_key_check check (column_key ~ '^[a-z][a-z0-9-]{0,30}$'),
  constraint asn_site_matrix_columns_label_check check (char_length(label) between 1 and 20)
);
comment on table public.asn_site_matrix_columns is '支援總表的功能欄（開啟、關閉、接手、切換模型、群組聊天、帳號切換）。第一欄「AI」與最後一欄「備註與限制」由頁面固定。';

create table if not exists public.asn_site_matrix_rows (
  row_key text not null,
  name text not null,
  kind text not null,
  note text not null,
  sort_order integer not null,
  constraint asn_site_matrix_rows_pkey primary key (row_key),
  constraint asn_site_matrix_rows_key_check check (row_key ~ '^[a-z][a-z0-9-]{0,30}$'),
  constraint asn_site_matrix_rows_name_check check (char_length(name) between 1 and 30),
  constraint asn_site_matrix_rows_kind_check check (char_length(kind) between 1 and 30),
  constraint asn_site_matrix_rows_note_check check (char_length(note) between 1 and 2000)
);
comment on table public.asn_site_matrix_rows is '支援總表的列：一家 AI 的一種形態（name＋kind，例如 Grok／雲端代理）；note 是「備註與限制」欄。';

create table if not exists public.asn_site_matrix_cells (
  row_key text not null,
  column_key text not null,
  status text not null,
  body text not null,
  refs integer[] not null default '{}',
  updated_at timestamptz not null default now(),
  constraint asn_site_matrix_cells_pkey primary key (row_key, column_key),
  constraint asn_site_matrix_cells_row_fkey foreign key (row_key) references public.asn_site_matrix_rows (row_key) on delete cascade,
  constraint asn_site_matrix_cells_column_fkey foreign key (column_key) references public.asn_site_matrix_columns (column_key) on delete cascade,
  constraint asn_site_matrix_cells_status_check check (status = any (array['ok', 'unv', 'doing', 'todo', 'tbc', 'na'])),
  constraint asn_site_matrix_cells_body_check check (char_length(body) between 1 and 4000),
  constraint asn_site_matrix_cells_refs_check check (cardinality(refs) <= 30 and 0 < all (refs))
);
comment on table public.asn_site_matrix_cells is '支援總表的格子。status：ok 已完成並驗證、unv 已完成未驗證、doing 進行中、todo 尚未做、tbc 待確認、na 不適用；查不到依據一律標 tbc 並寫明原因。';

-- 權限：公開唯讀。Supabase 對 public 的新表預設給 anon／authenticated 全部權限，這裡先全部收回再只給讀。
do $$
declare t text;
begin
  foreach t in array array['asn_site_releases', 'asn_site_meetings', 'asn_site_lanes', 'asn_site_roadmap_items',
                           'asn_site_matrix_columns', 'asn_site_matrix_rows', 'asn_site_matrix_cells'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to anon, authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_read', t);
  end loop;
end
$$;

commit;
