// 網頁版第 0 階段的後台地基（20261119200000_web_sessions.sql，#1751）。
// 網頁用登入身分、不持有長期金鑰、只能做明確列入的動作；網頁節點走獨立路線，不改變手機與電腦的收信。
// 涵蓋：網頁開著舊手機照樣收得到信、網頁不收那幾種通知（寫入時刪列＋讀取時再過濾）、收信監控不把網頁判成卡住、
//   名單預設不含網頁、遠端安裝與更新對網頁回 unsupported_platform、網頁不佔真設備名額、網頁節點上限、佔位 key_hash 比對不到、
//   門鈴不敲網頁、登入記錄（新瀏覽器通知、登出）、回復檔套下去函式回到原本的定義。
// 舊函式一律從各自最後一次定義的 migration 取出來裝進測試庫（等於正式庫現況），再套新 migration，走真實升級路徑。
// 沒裝 @electric-sql/pglite 時只跑靜態部分。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = s => s.replace(/\r+\n/g, '\n')
const DIR = new URL('../supabase/migrations/', import.meta.url)
const NAME = '20261119200000_web_sessions'
const mig = rd(fs.readFileSync(new URL(`${NAME}.sql`, DIR), 'utf8'))
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${NAME}_down.sql`, import.meta.url), 'utf8'))

// 從 migration 檔取出整支函式（create or replace function schema.name( … $tag$;）；nth 是同名第幾個（多載時用）
function fnOf(file, schema, name, nth = 0) {
  const s = rd(fs.readFileSync(new URL(file, DIR), 'utf8'))
  const re = new RegExp(`create or replace function ${schema}\\.${name}\\(`, 'gi')
  const hits = [...s.matchAll(re)]
  assert.ok(hits[nth], `${file} 找不到 ${schema}.${name}`)
  const st = hits[nth].index
  const tag = /\$\w*\$/.exec(s.slice(st))[0]
  const i = s.indexOf(tag, st) + tag.length
  const j = s.indexOf(tag, i) + tag.length
  return s.slice(st, s.indexOf(';', j) + 1)
}

// 被這支 migration 換掉的既有函式（檔名＝各自最後一次定義的 migration）
const REPLACED = [
  ['20261104190000_owner_mail_phone.sql', 'public', 'asn_relay_send_core'],
  ['20261111100000_notice_center.sql', 'public', 'asn_relay_send_notice'],
  ['20261111100000_notice_center.sql', 'public', 'asn_chat_history'],
  ['20261112100000_inbox_watch_per_agent.sql', 'public', 'asn_relay_inbox_watch'],
  ['20261117100000_secret_target.sql', 'public', 'asn_setup_request'],
  ['20261117100000_secret_target.sql', 'public', 'asn_relay_setup_poll'],
  ['20261021070000_asn_remote_update.sql', 'public', 'asn_update_request'],
  ['20261113500000_device_rename.sql', 'public', 'asn_node_create'],
  ['20261022050000_cloud_agent_invite.sql', 'public', 'asn_cloud_node_create'],
  ['20261024120000_device_code.sql', 'public', 'asn_device_code_approve'],
  ['20261114100000_perm_requests_full_options.sql', 'public', 'asn_relay_perm_req_create'],
  ['20261023060000_secret_remote.sql', 'public', 'asn_relay_secret_request'],
  ['20261023170000_groups_p1a_schema.sql', 'relay', 'room_bells'],
  ['20261021030000_account_login.sql', 'relay', 'asn_account_nodes'],
  ['20261021070000_asn_remote_update.sql', 'public', 'asn_update_status'],
  ['20261102140000_setup_requests.sql', 'public', 'asn_setup_status'],
  ['20261117200000_roster_elevated.sql', 'public', 'asn_relay_list'],
]

test('靜態：回復檔的每支函式逐字等於各自最後一次的定義；新 migration 排在最新的 migration 之後', () => {
  for (const [file, schema, name] of REPLACED) {
    const old = fnOf(file, schema, name)
    assert.ok(down.includes(old), `回復檔缺 ${name} 的原文`)
  }
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
  assert.equal(files.indexOf(`${NAME}.sql`), files.length - 1, '要是最新的一支')
  assert.ok(files.indexOf(`${NAME}.sql`) > files.indexOf('20261119100000_term_view_input_off.sql'))
})

test('靜態：新函式都是 security definer＋search_path 空、只授權 service_role；新表開 RLS 且不建 policy', () => {
  const body = mig.replace(/^--.*$/gm, '')
  for (const sig of ['public.asn_relay_web_touch(uuid, uuid, text, text, boolean)', 'public.asn_relay_web_session_is_web(uuid)',
    'public.asn_relay_web_sessions_list(uuid, uuid)', 'public.asn_relay_web_logout_all(uuid)', 'public.asn_relay_list(uuid, boolean)']) {
    assert.ok(body.includes(`revoke all on function ${sig} from public, anon, authenticated;`), sig)
    assert.ok(body.includes(`grant execute on function ${sig} to service_role;`), sig)
  }
  for (const sig of ['relay.web_denied_notice(text)', 'relay.web_browser_label(text)', 'relay.web_lane_targets(uuid, uuid, text)']) {
    assert.ok(body.includes(`revoke all on function ${sig} from public, anon, authenticated;`), sig)
  }
  assert.match(body, /alter table relay\.web_sessions enable row level security;/)
  assert.match(body, /revoke all on relay\.web_sessions from public, anon, authenticated;/)
  assert.doesNotMatch(body, /create policy/i)
  assert.doesNotMatch(body, /grant [^;]*to (anon|authenticated|public)/i)
  assert.doesNotMatch(body, /drop (table|column)/i)
  assert.match(body, /drop function if exists public\.asn_relay_list\(uuid\);/)
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟，整支失敗、不會無聲略過
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
closeAtEnd()

const T = 'aaaaaaaa-0000-0000-0000-000000000001'
const O = 'bbbbbbbb-0000-0000-0000-000000000001'
const OTHER = 'cccccccc-0000-0000-0000-000000000001'
const ALIAS = 'u:bbbbbbbb0000'
const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)
const S = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const SCHEMA = `
  create role service_role; create role anon; create role authenticated; create schema relay;
  create table relay.tenants(id uuid primary key default gen_random_uuid(), owner_user uuid unique, character_node text, owner_name text, id_prefix text, status text not null default 'active');
  create table relay.nodes(id text primary key, name text not null default 'n', key_hash text not null unique, bell_topic text not null unique,
    created_at timestamptz not null default now(), kind text, status text not null default 'active', last_seen_at timestamptz, role text not null default 'member',
    machine text, can_invite boolean not null default false, can_roster boolean not null default true, tenant_id uuid, owner_user uuid, platform text,
    created_via text, device_id text, name_by_owner boolean not null default false, inbox_hold_until timestamptz, last_active_at timestamptz,
    claude_mod jsonb, claude_mod_at timestamptz, avatar text, avatar_updated_at timestamptz, prev_key_hash text, prev_key_until timestamptz);
  create table relay.device_keys(node text primary key, platform text, sign_pub text);
  create table relay.asn_presence(node text, window_name text, version text, status text, psm text, updated_at timestamptz not null default now(), fg_at timestamptz);
  create table relay.messages(id uuid primary key default gen_random_uuid(), from_node text, from_agent text, to_node text, to_agent text, body text, reply_to uuid,
    tenant_id uuid, expects_reply boolean, owner_signed boolean, person_user uuid, fanout_id uuid, kind text, delivered_at timestamptz, acked_at timestamptz,
    created_at timestamptz not null default now(), to_partner_id text, from_partner_id text, voice boolean);
  create table relay.account_events(id bigint generated always as identity primary key, user_id uuid, event text, node text, detail jsonb, at timestamptz not null default now());
  create table relay.roster(node text, name text, status text, cwd_label text, engine text, detail text, context_pct int, mod_loaded boolean, kind text, receivable boolean,
    model text, hidden boolean, elevated boolean, seen_at timestamptz default now());
  create table relay.partners(partner_id text, tenant_id uuid, node text, current_name text, last_active_at timestamptz, avatar text, avatar_updated_at timestamptz);
  create table relay.partner_archives(tenant_id uuid, node text, key text);
  create table relay.room_members(room_id text, member text, left_at timestamptz);
  create table relay.setup_requests(node text primary key, requested_by uuid, kind text, status text, detail text, replaced text, requested_at timestamptz, updated_at timestamptz,
    rid text, req_payload text, req_sig text, req_p_node text, t_eph_pub text, cipher text, t_sig text, cipher_put_at timestamptz, delivered_at timestamptz,
    expires_at timestamptz, mode text, requester_phone text);
  create table relay.asn_update_requests(node text primary key, requested_by uuid, status text, from_version text, detail text, requested_at timestamptz, updated_at timestamptz);
  create table relay.inbox_watch(node text primary key, state text not null default 'ok', level text not null default '0', last_count integer not null default 0,
    last_oldest_at timestamptz, stuck_since timestamptz, notified_at timestamptz, recovered_at timestamptz, updated_at timestamptz not null default now(),
    alert_since timestamptz, episode_oldest_at timestamptz, shadow_noticed_at timestamptz, stuck_agents integer not null default 0, orphan_count integer not null default 0);
  create table relay.inbox_watch_log(id bigint generated always as identity primary key, node text, at timestamptz not null default now(), from_state text, to_state text,
    note text, cnt integer, oldest_at timestamptz, stuck_since timestamptz, would_notify boolean, agents integer);
  create table relay.perm_requests(id uuid primary key default gen_random_uuid(), tenant_id uuid, node text, window_name text, prompt_text text, complete boolean, options jsonb,
    body_hash text, options_full jsonb, risk jsonb, full_len integer, status text not null default 'pending', created_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '5 minutes');
  create table relay.secret_requests(id uuid primary key default gen_random_uuid(), tenant_id uuid, owner_user uuid, requester_node text, program text, purpose text,
    pub text, status text not null default 'pending', created_at timestamptz not null default now(), expires_at timestamptz, link text, target_node text);
  create function public.asn_person_alias(u uuid) returns text language sql as $$ select 'u:bbbbbbbb0000' $$;
  create function relay.setup_kind_version_ok(v text, k text) returns boolean language sql as $$ select true $$;
  create function relay.setup_relogin_version_ok(v text) returns boolean language sql as $$ select true $$;
  create function public.asn_relay_perm_req_expire() returns void language sql as $$ select 1 $$;
  create function public.asn_relay_secret_purge() returns void language sql as $$ select 1 $$;
  create function relay.asn_ensure_tenant(p_user uuid, p_name text) returns relay.tenants language plpgsql as $$
    declare t relay.tenants;
    begin
      select * into t from relay.tenants where owner_user = p_user;
      if not found then
        insert into relay.tenants(owner_user, id_prefix) values (p_user, 't' || (select count(*) + 1 from relay.tenants) || '-') returning * into t;
      end if;
      return t;
    end $$;`

// 舊的 asn_relay_send 只是轉呼叫 core；測試庫用最小替身
const SEND_STUB = `create function public.asn_relay_send(p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid,
    p_expects_reply boolean default null, p_signed_user uuid default null, p_as_person boolean default false) returns jsonb language plpgsql as $$
  begin return public.asn_relay_send_core(p_from_node, p_from_agent, p_to_node, p_to_agent, p_body, p_reply_to, p_expects_reply, p_signed_user, p_as_person); end $$;`

async function boot({ upgrade = true } = {}) {
  const db = track(new PGlite())
  await db.exec(SCHEMA)
  await db.exec('set check_function_bodies = off') // 舊函式引用的其他資料表（device_codes 等）測試庫沒有；函式本體在實跑時才解析
  await db.exec(fnOf('20261021060000_owner_signed.sql', 'public', 'asn_user_owns_node'))
  await db.exec(fnOf('20261113300000_node_key_rotate.sql', 'public', 'asn_relay_auth'))
  for (const [f, sc, n] of REPLACED) await db.exec(fnOf(f, sc, n, n === 'asn_relay_perm_req_create' ? 0 : 0))
  await db.exec(SEND_STUB)
  // 改名時留下的舊名轉呼叫（正式庫現況）：拿掉舊簽章 asn_relay_list(uuid) 之後它仍要能用
  await db.exec(`create function public.irori_relay_list(p_tenant uuid) returns jsonb language sql security definer set search_path to '' as $$ select public.asn_relay_list(p_tenant) $$`)
  if (upgrade) await db.exec(mig)
  await db.exec(`insert into relay.tenants(id, owner_user, id_prefix) values ('${T}', '${O}', 't1-')`)
  const q = async (t, a) => (await db.query(t, a)).rows
  const node = (id, o = {}) => db.query(
    `insert into relay.nodes(id, name, key_hash, bell_topic, kind, role, platform, tenant_id, owner_user, status, last_seen_at, created_at, created_via, device_id)
     values ($1, $1, $2, $3, $4, 'member', $5, $6, $7, $8, case when $9::text is null then null else now() - $9::interval end, now() - $10::interval, $11, null)`,
    [id, o.kind === 'web' ? 'web:' + id : 'h-' + id, 'bell-' + id, o.kind ?? 'other', o.kind === 'web' ? 'web' : (o.platform ?? null), T, o.owner === undefined ? O : o.owner, o.status ?? 'active',
      o.seen ?? null, o.age ?? '1 day', o.kind === 'web' ? 'web-login' : null])
  const seen = (n, win, ago = '1 minute') => db.query(`insert into relay.asn_presence(node, window_name, updated_at) values ($1, $2, now() - $3::interval)`, [n, win, ago])
  const send = async (from = 'AI', to = ALIAS, body = '內文') => (await q(`select public.asn_relay_send_core($1, '收發室', $2, null, $3, null) r`, [from, to, body]))[0].r
  const rows = async (ex = '') => (await q(`select to_node, to_agent, fanout_id, id from relay.messages order by to_node, to_agent`)).filter(r => !ex || r.to_node !== ex)
  return { db, q, node, seen, send, rows }
}

// 網頁開著時的標準情境：舊手機（沒回報 platform）是帳號最早的節點，AI 是寄件人，W1 是開著的網頁
async function scenarioOldPhone(db_, withWeb) {
  const { node, seen, send, rows, q } = db_
  await node('PH', { age: '5 days' })
  await node('AI', { kind: 'claude', age: '1 day' })
  if (withWeb) { await node('W1', { kind: 'web' }); await seen('W1', 'whatever') }
  const r = await send()
  return { r, rows: await rows(), q }
}

test('實跑：網頁開著，沒回報 platform 的舊手機照樣收得到寄給本人的信；網頁另外多收一列，不當頭一列', { skip }, async () => {
  const b = await boot()
  const { r, rows } = await scenarioOldPhone(b, true)
  const got = rows.map(x => `${x.to_node}/${x.to_agent}`)
  assert.deepEqual(got, [`PH/${ALIAS}`, 'W1/web'])
  assert.equal(r.fanout, 0, '網頁不算進 fanout（推播判斷不看網頁）')
  assert.deepEqual(r.bell_topics, ['bell-PH', 'bell-W1'])
  const ph = rows.find(x => x.to_node === 'PH')
  const w = rows.find(x => x.to_node === 'W1')
  assert.equal(w.fanout_id, ph.id, '網頁那列掛在原收件那列底下，不是頭一列')
  assert.equal(r.id, ph.id)
})

test('實跑：同一個情境在舊程式上，網頁一開手機就收不到（驗證新測試在舊程式上會紅）', { skip }, async () => {
  const b = await boot({ upgrade: false })
  const { rows } = await scenarioOldPhone(b, true)
  assert.deepEqual(rows.map(x => x.to_node), ['W1'], '舊程式：只有網頁收到、手機一份都沒有')
})

test('實跑：網頁開不開，電腦與手機的收信完全相同（逐列、門鈴、fanout）', { skip }, async () => {
  const run = async withWeb => {
    const b = await boot()
    const { node, seen, send, rows } = b
    await node('PC', { platform: 'windows', age: '3 days' })
    await node('PHA', { platform: 'android', age: '2 days' })
    await node('AI', { kind: 'claude', age: '1 day' })
    await seen('PC', '電腦', '1 minute')
    await seen('PHA', '手機', '1 hour')
    if (withWeb) { await node('W1', { kind: 'web' }); await seen('W1', 'x') }
    const r = await send()
    const { id, fanout_id: _f, ...rest } = r
    return { r: { ...rest, bell_topics: r.bell_topics.filter(t => t !== 'bell-W1') }, rows: (await rows('W1')).map(x => `${x.to_node}/${x.to_agent}`) }
  }
  assert.deepEqual(await run(true), await run(false))
})

test('實跑：寄件人自己是網頁節點時，不會寄回給自己；沒有在線網頁、或網頁超過 3 分鐘沒回報，就不留列', { skip }, async () => {
  const { node, seen, send, rows, db } = await boot()
  await node('PC', { platform: 'windows', age: '3 days' })
  await node('W1', { kind: 'web' }); await seen('W1', 'x', '10 minutes')
  await node('W2', { kind: 'web' }); await seen('W2', 'x', '1 minute')
  await seen('PC', '電腦')
  await send('W2')
  assert.deepEqual((await rows()).map(x => x.to_node), ['PC'], '舊的網頁不收、寄件人自己不收')
  await db.exec('delete from relay.messages')
  await send('PC')
  assert.deepEqual((await rows()).map(x => x.to_node), ['PC', 'W2'])
})

test('實跑：網頁節點不會被挑成保底的收件節點', { skip }, async () => {
  const { node, send, rows } = await boot()
  await node('W1', { kind: 'web', age: '9 days' }) // 帳號名下最早的 active 節點是網頁
  await node('PC', { platform: 'windows', age: '3 days' })
  await node('AI', { kind: 'claude', age: '1 day' })
  await send()
  assert.deepEqual((await rows()).map(x => x.to_node), ['PC'])
})

test('實跑：網頁不收登入、等待確認、設備金鑰、看畫面四種通知；其他通知照收；門鈴不敲網頁', { skip }, async () => {
  const { node, seen, q, db } = await boot()
  await node('PC', { platform: 'windows', age: '3 days' })
  await node('AI', { kind: 'claude', age: '1 day' })
  await node('W1', { kind: 'web' })
  await seen('PC', '電腦'); await seen('W1', 'x')
  for (const topic of ['login', 'waiting', 'device_key', 'view', 'quota', 'misroute', 'web_login']) {
    await db.exec('delete from relay.messages')
    const r = (await q(`select public.asn_relay_send_notice('AI', $1, '通知內文') r`, [topic]))[0].r
    assert.equal(r.notify, 'sent', topic)
    const web = await q(`select kind from relay.messages where to_node = 'W1'`)
    const denied = ['login', 'waiting', 'device_key', 'view'].includes(topic)
    assert.equal(web.length, denied ? 0 : 1, `${topic}：網頁${denied ? '不該' : '該'}收到`)
    assert.equal(r.bell_topics.includes('bell-W1'), !denied, `${topic}：門鈴`)
    assert.ok((await q(`select 1 from relay.messages where to_node = 'PC'`)).length >= 1, '電腦照收')
  }
})

test('實跑：舊程式上，登入通知會寄給網頁（驗證新測試在舊程式上會紅）', { skip }, async () => {
  const { node, seen, q } = await boot({ upgrade: false })
  await node('PC', { platform: 'windows', age: '3 days' }); await node('AI', { kind: 'claude' }); await node('W1', { kind: 'web' })
  await seen('PC', '電腦'); await seen('W1', 'x')
  await q(`select public.asn_relay_send_notice('AI', 'login', '通知內文')`)
  assert.equal((await q(`select 1 from relay.messages where to_node = 'W1'`)).length, 1)
})

test('實跑：往來記錄對網頁節點再過濾一次（直接塞進表的登入通知，網頁也讀不到；電腦讀得到）', { skip }, async () => {
  const { node, q, db } = await boot()
  await node('PC', { platform: 'windows' }); await node('AI', { kind: 'claude' }); await node('W1', { kind: 'web' })
  await db.exec(`insert into relay.messages(from_node, from_agent, to_node, to_agent, body, tenant_id, person_user, kind, created_at) values
    ('AI', 'ASN 通知', 'PC', '${ALIAS}', '登入失效', '${T}', '${O}', 'notice:login', now() - interval '2 minutes'),
    ('AI', 'ASN 通知', 'PC', '${ALIAS}', '額度', '${T}', '${O}', 'notice:quota', now() - interval '1 minute'),
    ('AI', 'ASN 通知', 'PC', '${ALIAS}', '一般信', '${T}', '${O}', null, now())`)
  const kinds = async p => (await q(`select public.asn_chat_history('${O}', $1, 'AI', 'ASN 通知') r`, [p]))[0].r.messages.map(m => m.kind)
  assert.deepEqual(await kinds('PC'), ['notice:login', 'notice:quota', null])
  assert.deepEqual(await kinds('W1'), ['notice:quota', null])
})

test('實跑：收信監控不把網頁判成卡住（不列入檢查）', { skip }, async () => {
  const run = async upgrade => {
    const { node, q, db } = await boot({ upgrade })
    await node('PC', { platform: 'windows', seen: '0 seconds' })
    await node('W1', { kind: 'web', seen: '0 seconds' })
    await db.exec(`update relay.nodes set last_seen_at = now(); insert into relay.messages(from_node, to_node, to_agent, body, created_at)
      select 'AI', 'W1', 'web', 'x', now() - interval '30 minutes' from generate_series(1, 10)`)
    return (await q(`select public.asn_relay_inbox_watch(false) r`))[0].r.nodes
  }
  assert.equal(await run(true), 1)
  assert.equal(await run(false), 2, '舊程式把網頁也算進去')
})

test('實跑：名單預設不含網頁；網頁自己傳 p_include_web=true 才看得到；舊呼叫方式（只帶租戶）照常能呼叫', { skip }, async () => {
  const { node, q } = await boot()
  await node('PC', { platform: 'windows', seen: '0 seconds' }); await node('W1', { kind: 'web' })
  const ids = async sql => (await q(sql, [T]))[0].r.map(n => n.id)
  assert.deepEqual(await ids(`select public.asn_relay_list($1::uuid) r`), ['PC'])
  assert.deepEqual(await ids(`select public.asn_relay_list(p_tenant => $1::uuid) r`), ['PC'])
  assert.deepEqual(await ids(`select public.asn_relay_list($1::uuid, true) r`), ['PC', 'W1'])
  assert.equal((await q(`select count(*)::int n from pg_proc where proname = 'asn_relay_list'`))[0].n, 1, '只有一個版本，沒有多載歧義')
  assert.deepEqual(await ids(`select public.irori_relay_list($1::uuid) r`), ['PC'], '舊名轉呼叫照常能用')
})

test('實跑：遠端安裝與更新對網頁節點回 unsupported_platform；取請求時不交給網頁；狀態清單不列網頁', { skip }, async () => {
  const { node, q } = await boot()
  await node('PC', { platform: 'windows' }); await node('W1', { kind: 'web' })
  await q(`insert into relay.asn_presence(node, window_name, updated_at) values ('PC', 'a', now()), ('W1', 'a', now())`)
  assert.equal((await q(`select public.asn_setup_request($1::uuid, 'W1') r`, [O]))[0].r.error, 'unsupported_platform')
  assert.equal((await q(`select public.asn_update_request($1::uuid, 'W1') r`, [O]))[0].r.error, 'unsupported_platform')
  assert.equal((await q(`select public.asn_relay_setup_poll('W1', '0.2.40') r`))[0].r.requested, false)
  assert.equal((await q(`select public.asn_update_request($1::uuid, 'PC') r`, [O]))[0].r.error, undefined, '電腦照常')
  assert.deepEqual((await q(`select public.asn_update_status($1::uuid) r`, [O]))[0].r.map(n => n.id), ['PC'])
  assert.deepEqual((await q(`select public.asn_setup_status($1::uuid) r`, [O]))[0].r.map(n => n.id), ['PC'])
  assert.deepEqual((await q(`select relay.asn_account_nodes($1::uuid) r`, [O]))[0].r.map(n => n.id), ['PC'])
})

test('實跑：網頁節點不佔真設備的名額（19 台真設備＋10 個網頁，仍能建第 20 台）；舊程式會擋', { skip }, async () => {
  const run = async upgrade => {
    const { node, q } = await boot({ upgrade })
    for (let i = 0; i < 19; i++) await node('D' + i, { platform: 'windows' })
    for (let i = 0; i < 10; i++) await node('W' + i, { kind: 'web' })
    const r = (await q(`select public.asn_node_create($1::uuid, '新電腦', '新電腦', $2, 'hash-new', 'bell-new') r`, [O, 'devid-' + 'x'.repeat(16)]))[0].r
    const r2 = (await q(`select public.asn_node_create($1::uuid, '第二十一台', '第二十一台', $2, 'hash-new2', 'bell-new2') r`, [O, 'devid2-' + 'x'.repeat(16)]))[0].r
    return [r.error ?? 'ok', r2.error ?? 'ok']
  }
  assert.deepEqual(await run(true), ['ok', 'too_many'])
  assert.deepEqual(await run(false), ['too_many', 'too_many'])
})

test('實跑：權限請求與密碼請求的門鈴不敲網頁；群組門鈴與其他帳號不受影響', { skip }, async () => {
  const { node, q, db } = await boot()
  await node('PC', { platform: 'windows' }); await node('PHA', { platform: 'android' }); await node('W1', { kind: 'web' })
  const perm = (await q(`select public.asn_relay_perm_req_create('PC', '視窗', '要不要？', true, '[{"n":1,"label":"好"}]'::jsonb, $1, null, null, null) r`, ['a'.repeat(64)]))[0].r
  assert.deepEqual(perm.bell_topics, ['bell-PHA'])
  const sec = (await q(`select public.asn_relay_secret_request('PC', $1, '程式', '用途', 60) r`, ['p'.repeat(43)]))[0].r
  assert.equal(sec.error, undefined)
  assert.deepEqual(sec.bell_topics, ['bell-PHA'])
  await db.exec(`insert into relay.room_members values ('R1', '~u:${O}', null), ('R1', 'PC', null)`)
  assert.deepEqual((await q(`select relay.room_bells('R1') r`))[0].r.sort(), ['bell-PC', 'bell-PHA'])
})

test('實跑：佔位 key_hash 永遠比對不到；檢查式兩個方向都鎖（網頁節點不能有真的雜湊、真設備不能用 web: 開頭）', { skip }, async () => {
  const { node, q, db } = await boot()
  await node('PC', { platform: 'windows' }); await node('W1', { kind: 'web' })
  const auth = async h => (await q(`select * from public.asn_relay_auth($1)`, [h])).map(r => r.id)
  assert.deepEqual(await auth('h-PC'), ['PC'], '對照組：真節點比得到')
  for (const h of ['', 'web:', 'h-W1', 'a'.repeat(64)]) assert.deepEqual(await auth(h), [], `「${h}」比不到網頁節點`)
  const bad = sql => assert.rejects(db.exec(sql))
  await bad(`insert into relay.nodes(id, key_hash, bell_topic, kind, created_via, platform) values ('X1', '${'c'.repeat(64)}', 'bx1', 'web', 'web-login', 'web')`)
  await bad(`insert into relay.nodes(id, key_hash, bell_topic, kind, platform) values ('X2', 'web:abc', 'bx2', 'other', 'windows')`)
  await bad(`insert into relay.nodes(id, key_hash, bell_topic, kind, platform) values ('X3', 'web:abc', 'bx3', 'web', 'web')`)
  await bad(`insert into relay.nodes(id, key_hash, bell_topic, kind, created_via, platform, device_id) values ('X4', 'web:abd', 'bx4', 'web', 'web-login', 'web', 'devid-xxxxxxxxxxxxxxxx')`)
  await db.exec(`insert into relay.nodes(id, key_hash, bell_topic, kind, created_via, platform) values ('X5', 'web:ok', 'bx5', 'web', 'web-login', 'web')`)
  await db.exec(`insert into relay.nodes(id, key_hash, bell_topic, kind, created_via, platform) values ('X6', 'web:ok2', 'bx6', 'web', 'web-login', 'web')`)
  await db.exec(`insert into relay.device_keys(node, platform) values ('X5', 'web')`)
})

test('實跑：網頁登入記錄：第一次登入建節點與登入記錄並寄信；同瀏覽器再登入不再寄信；新瀏覽器再寄', { skip }, async () => {
  const { node, q } = await boot()
  await node('PC', { platform: 'windows', age: '3 days' })
  const touch = async (s, h, create = true) => (await q(`select public.asn_relay_web_touch($1::uuid, $2::uuid, $3, $4, $5) r`, [O, S(s), h, 'Chrome（Windows）', create]))[0].r
  assert.equal((await touch(1, H1, false)).error, 'unknown', '沒登記又不建立')
  const a = await touch(1, H1)
  assert.equal(a.created, true); assert.equal(a.first, true)
  assert.deepEqual(Object.keys(a.node).sort(), ['bell_topic', 'id', 'role', 'tenant_id'])
  assert.equal(a.node.role, 'member')
  assert.equal(a.notice.notify, 'sent')
  const n = (await q(`select kind, platform, created_via, status, key_hash, role from relay.nodes where id = $1`, [a.node.id]))[0]
  assert.deepEqual([n.kind, n.platform, n.created_via, n.status, n.role], ['web', 'web', 'web-login', 'active', 'member'])
  assert.match(n.key_hash, /^web:/)
  assert.equal((await q(`select count(*)::int c from relay.messages where kind = 'notice:web_login'`))[0].c, 1)
  const mail = (await q(`select body from relay.messages where kind = 'notice:web_login' limit 1`))[0].body
  assert.ok(mail.includes('Chrome（Windows）') && !mail.includes(H1))
  // 同一個 session 再來：回同一個節點，不再建、不再寄
  const again = await touch(1, H1)
  assert.equal(again.created, false); assert.equal(again.node.id, a.node.id)
  // 同一個瀏覽器、新的登入（session 不同）：建新節點，但不是新瀏覽器、不寄信
  const b = await touch(2, H1)
  assert.equal(b.created, true); assert.equal(b.first, false); assert.equal(b.notice, null)
  // 新瀏覽器
  const c = await touch(3, H2)
  assert.equal(c.first, true)
  assert.equal((await q(`select count(*)::int c from relay.messages where kind = 'notice:web_login'`))[0].c, 2)
  // 身分或瀏覽器對不上：一律 forbidden
  assert.equal((await touch(1, H2)).error, 'forbidden')
  assert.equal((await q(`select public.asn_relay_web_touch($1::uuid, $2::uuid, $3, 'x', true) r`, [OTHER, S(1), H1]))[0].r.error, 'forbidden')
  assert.equal((await touch(9, 'zz')).error, 'bad_request')
})

test('實跑：網頁節點每個帳號最多 10 個有效的；登出之後空出名額；不佔 20 台名額', { skip }, async () => {
  const { node, q } = await boot()
  await node('PC', { platform: 'windows', age: '3 days' })
  const touch = async s => (await q(`select public.asn_relay_web_touch($1::uuid, $2::uuid, $3, 'Firefox', true) r`, [O, S(s), H1]))[0].r
  for (let i = 1; i <= 10; i++) assert.equal((await touch(i)).created, true, `第 ${i} 個`)
  assert.equal((await touch(11)).error, 'too_many')
  assert.equal((await touch(5)).created, false, '已登記的不受名額影響')
  const out = (await q(`select public.asn_relay_web_logout_all($1::uuid) r`, [O]))[0].r
  assert.equal(out.count, 10); assert.equal(out.bell_topics.length, 10)
  assert.equal((await touch(11)).created, true, '登出後空出名額')
})

test('實跑：一鍵登出：被登出的網頁打任何動作都被擋（signed_out）；節點撤銷；清單看得到；session 仍判為網頁', { skip }, async () => {
  const { node, q } = await boot()
  await node('PC', { platform: 'windows', age: '3 days' })
  const touch = async (s, create = true) => (await q(`select public.asn_relay_web_touch($1::uuid, $2::uuid, $3, 'Safari', $4) r`, [O, S(s), H1, create]))[0].r
  const a = await touch(1); await touch(2)
  assert.equal((await q(`select public.asn_relay_web_session_is_web($1::uuid) r`, [S(1)]))[0].r, true)
  assert.equal((await q(`select public.asn_relay_web_session_is_web($1::uuid) r`, [S(99)]))[0].r, false, '一般的登入（手機、電腦）不是網頁')
  const list = (await q(`select public.asn_relay_web_sessions_list($1::uuid, $2::uuid) r`, [O, S(1)]))[0].r
  assert.equal(list.length, 2); assert.equal(list.filter(x => x.current).length, 1)
  assert.ok(list.every(x => !('device_hash' in x) && !('session_id' in x)))
  assert.equal((await q(`select public.asn_relay_web_sessions_list($1::uuid, null) r`, [OTHER]))[0].r.length, 0, '別人的清單是空的')
  await q(`select public.asn_relay_web_logout_all($1::uuid)`, [O])
  assert.equal((await touch(1)).error, 'signed_out')
  assert.equal((await touch(1, false)).error, 'signed_out')
  assert.equal((await touch(2)).error, 'signed_out')
  assert.equal((await q(`select status from relay.nodes where id = $1`, [a.node.id]))[0].status, 'revoked')
  assert.equal((await q(`select public.asn_relay_web_session_is_web($1::uuid) r`, [S(1)]))[0].r, true, '登出後仍認得是網頁的 session')
  assert.deepEqual((await q(`select * from public.asn_relay_auth('web:anything')`)), [])
})

test('實跑：瀏覽器摘要去掉控制字元與改變文字方向的字元、限 40 字、空的給預設', { skip }, async () => {
  const { q } = await boot()
  const lab = async s => (await q(`select relay.web_browser_label($1) r`, [s]))[0].r
  assert.equal(await lab('Chrome‮\n（Windows）⁦'), 'Chrome （Windows）')
  assert.equal((await lab('x'.repeat(100))).length, 40)
  assert.equal(await lab('  '), '瀏覽器')
  assert.equal(await lab(null), '瀏覽器')
})

test('實跑：回復檔套下去，每支函式回到原本的定義；新函式與新表消失；網頁節點變成已撤銷的一般節點，信不動', { skip }, async () => {
  const defs = async db => {
    const out = {}
    for (const [, sc, n] of REPLACED) {
      const r = (await db.query(`select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace s on s.oid = p.pronamespace where p.proname = $1 and s.nspname = $2 order by 1`, [n, sc])).rows.map(x => x.d)
      out[n] = r
    }
    return out
  }
  const base = await boot({ upgrade: false })
  const want = await defs(base.db)
  const b = await boot()
  await b.node('PC', { platform: 'windows', age: '3 days' })
  await b.q(`select public.asn_relay_web_touch($1::uuid, $2::uuid, $3, 'Edge', true)`, [O, S(1), H1])
  const nWeb = (await b.q(`select id from relay.nodes where kind = 'web'`))[0].id
  const nMail = (await b.q(`select count(*)::int c from relay.messages`))[0].c
  assert.notDeepEqual(await defs(b.db), want, '對照組：套新 migration 之後函式真的變了')
  await b.db.exec(down)
  assert.deepEqual(await defs(b.db), want)
  for (const f of ['asn_relay_web_touch', 'asn_relay_web_session_is_web', 'asn_relay_web_sessions_list', 'asn_relay_web_logout_all', 'web_lane_targets', 'web_denied_notice', 'web_browser_label']) {
    assert.equal((await b.q(`select count(*)::int n from pg_proc where proname = $1`, [f]))[0].n, 0, f)
  }
  assert.equal((await b.q(`select to_regclass('relay.web_sessions') t`))[0].t, null)
  const n = (await b.q(`select kind, status, platform, created_via, key_hash from relay.nodes where id = $1`, [nWeb]))[0]
  assert.deepEqual([n.kind, n.status, n.platform, n.created_via], ['other', 'revoked', null, 'login-device'])
  assert.equal((await b.q(`select count(*)::int c from relay.messages`))[0].c, nMail, '信一封不少')
  await assert.rejects(b.db.exec(`insert into relay.nodes(id, key_hash, bell_topic, platform) values ('Z', 'zz', 'bz', 'web')`), '舊的檢查式回來了')
  // 回復之後再套一次新 migration 也要能過（可重跑）
  await b.db.exec(mig)
  assert.equal((await b.q(`select count(*)::int n from pg_proc where proname = 'asn_relay_web_touch'`))[0].n, 1)
})

test('實跑：新 migration 可以套兩次（可重跑）', { skip }, async () => {
  const { db, q } = await boot()
  await db.exec(mig)
  assert.equal((await q(`select count(*)::int n from pg_proc where proname = 'asn_relay_list'`))[0].n, 1)
})
