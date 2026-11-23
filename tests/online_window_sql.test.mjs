// 後台「在線門檻」收成單一定義（#2161 第 1 段／機械收斂；migration 20261123120000_online_window.sql）。
// 1. 靜態：交易內、不刪資料、不授權 anon／authenticated／public、relay.online_window() 只授權 service_role、有回復說明、
//    除了 online_window 本體與三處 done_at 之外不再有 3 分鐘字面量。
// 2. 等價證明（pglite 實跑）：套完「不含本 migration 的全部 migration」取各函式的 pg_get_functiondef，再套本 migration 取一次：
//    (i) 改後 ＝ 改前把「在線門檻」的 3 分鐘字面量換成 relay.online_window()（逐函式字串相等，每個函式換幾處也鎖死）；
//    (ii) 清單外的函式 pg_get_functiondef 逐字不變、函式總數只多一個；
//    (iii) 授權與擁有者（proacl、owner、has_function_privilege）改前改後相同；
//    (iv) 資料庫裡所有函式本體的 3 分鐘字面量，除了明列的白名單（附理由）全部消失；
//    (v) 套 down 之後所有函式定義與改前逐字相同、online_window 被拿掉，之後可以再套一次。
//    pg_get_functiondef 的輸出：標頭是正規化寫法，本體（prosrc）逐字照印，所以 interval '3 minutes' 在本體裡仍是原樣的 interval '3 minutes'
//    （不會變成 '00:03:00'::interval——那是 view／預設值這類被解析過的運算式才會）；取代規則因此就是字串取代。
// 3. 行為測試（pglite 實跑，用全部真實 migration）：asn_relay_list 的 online／presence／agents／asn、asn_relay_send_core 的在線分送（三處）、
//    messages_resolve_partner 的轉寄（包在 exception when others then null 裡，壞了不報錯，所以要驗「真的有轉寄／真的沒轉寄」）。
//    每個案例都量 2 分 58 秒（在線）與 3 分 02 秒（離線）；並證明把 online_window() 改成 0 秒或 1 小時這些測試會變紅。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261123120000_online_window.sql'
const DOWN = new URL('../supabase/sql/rollback/20261123120000_online_window_down.sql', import.meta.url)
const norm = s => s.replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const read = f => norm(fs.readFileSync(new URL(f, DIR), 'utf8'))
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

const LIT = "interval '3 minutes'"
const NEW = 'relay.online_window()'

// 改完之後「在線門檻」各函式被換掉的處數（改前資料庫裡用腳本掃出來的；合計 31）。不在這張表的函式一律不得被改動。
const ONLINE_REPLACED = {
  'asn_cloud_node_list(uuid)': 1,
  'asn_relay_acct_list(text,text,uuid)': 1,
  'asn_relay_acct_switch(text,text,text,text,uuid)': 1,
  'asn_relay_inbox_watch(boolean)': 1,
  'asn_relay_launch(text,text,text,text,text,text,uuid)': 1,
  'asn_relay_launch(text,text,text,text,text,text,uuid,text,text)': 1,
  'asn_relay_launchers(text,uuid[],uuid)': 1,
  'asn_relay_list(uuid,boolean)': 5,
  'asn_relay_partner_archive(text,uuid,text,text,text,boolean)': 1,
  'asn_relay_partner_list(uuid,text)': 1,
  'asn_relay_partner_op(text,uuid,text,text,text,text,text,text)': 5,
  'asn_relay_partner_succeed(uuid,text,text,text,text)': 1,
  'asn_relay_send_core(text,text,text,text,text,uuid,boolean,uuid,boolean)': 3,
  'asn_setup_request(uuid,text,text,text,text,text,text,text)': 3,
  'asn_update_request(uuid,text)': 1,
  'relay.messages_resolve_partner()': 1,
  'relay.room_member_presence(text)': 2,
  'relay.web_lane_targets(uuid,uuid,text)': 1,
}
// 不是「在線」語意、數字剛好也是 3 分鐘、所以仍留字面量的地方（改後資料庫裡 3 分鐘字面量只准出現在這裡與 online_window 本體）
const LITERAL_WHITELIST = {
  'relay.online_window()': 1,                                                                  // 定義本身
  'asn_relay_acct_expire()': 1,                                                                // created_at：切換帳號請求 3 分鐘沒人取走就逾時（不是在線）
  'asn_relay_launch(text,text,text,text,text,text,uuid)': 1,                                  // done_at：剛開好的窗（啟動結果新鮮度）
  'asn_relay_launch(text,text,text,text,text,text,uuid,text,text)': 1,                        // done_at：同上
  'asn_relay_partner_op(text,uuid,text,text,text,text,text,text)': 1,                         // done_at：同上
  'asn_relay_push_targets(uuid,text)': 2,                                                      // fg_at：手機前景 3 分鐘內不推播（前景語意，不是在線）
}
const ONLINE_TOTAL = Object.values(ONLINE_REPLACED).reduce((a, b) => a + b, 0)

// 「在線門檻」以外的 3 分鐘：前面接的欄位是 done_at／fg_at／created_at 的比較
const KEEP = /\b(done_at|fg_at|created_at)\s*(>|<=|>=|<)\s*now\(\)\s*-\s*$/
function expectedAfter(def) {
  let out = '', pos = 0, n = 0
  for (const m of def.matchAll(/interval '3 minutes'/g)) {
    const prefix = def.slice(def.lastIndexOf('\n', m.index) + 1, m.index)
    if (KEEP.test(prefix)) continue
    out += def.slice(pos, m.index) + NEW
    pos = m.index + LIT.length
    n++
  }
  return { text: out + def.slice(pos), n }
}
// 各種 3 分鐘寫法（含 180 秒、00:03:00、make_interval）；前面不接數字，避免 13 分鐘、30 分鐘
const ANY_3MIN = /(?<![0-9.])3\s*min|(?<![0-9.])180\s*sec|00:03:00|mins\s*=>\s*3\b|secs\s*=>\s*180\b/gi

test('靜態：在交易內、不刪資料、不授權 anon／authenticated／public；online_window 只授權 service_role、有回復說明', () => {
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  const outside = code.replace(/\$function\$[\s\S]*?\$function\$/g, () => 'BODY')   // 函式本體之外的頂層敘述
  assert.doesNotMatch(outside, /drop table|drop column|delete from|truncate|drop function|alter table|insert into|update relay/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.match(code, /revoke all on function relay\.online_window\(\) from public, anon, authenticated;/)
  assert.match(code, /grant execute on function relay\.online_window\(\) to service_role;/)
  assert.equal((code.match(/grant /gi) ?? []).length, 1, '只有 online_window 一條 grant')
  assert.doesNotMatch(code.slice(0, code.indexOf('revoke all on function relay.online_window')), /security definer/i, 'online_window 不是 security definer')
  assert.match(code, /create or replace function relay\.online_window\(\) returns interval\s+language sql immutable set search_path to ''/)
  assert.match(sql, /^-- 回復：supabase\/sql\/rollback\/20261123120000_online_window_down\.sql/m)
  assert.ok(fs.existsSync(DOWN), 'down 檔存在')
  assert.ok(files.includes(MIG))
})

test('靜態：本 migration 的 3 分鐘字面量只有 online_window 本體（行尾標記）與三處 done_at', () => {
  const sql = read(MIG)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--'))
  const lits = code.filter(l => ANY_3MIN.test(l) || (ANY_3MIN.lastIndex = 0, false))
  ANY_3MIN.lastIndex = 0
  const def = lits.filter(l => /select interval '3 minutes'\s+-- online-window-definition\s*$/.test(l))
  const done = lits.filter(l => /\bdone_at > now\(\) - interval '3 minutes'/.test(l))
  assert.equal(def.length, 1, 'online_window 本體恰好一行，行尾標 -- online-window-definition')
  assert.equal(done.length, 3, 'done_at 三處（launch 兩版、partner_op）')
  assert.equal(lits.length, 4, `其他地方不得有 3 分鐘字面量：${lits.filter(l => !def.includes(l) && !done.includes(l)).join(' | ')}`)
  assert.equal((sql.match(/relay\.online_window\(\)/g) ?? []).length >= ONLINE_TOTAL + 1, true, '引用處數不少於 31＋定義')
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟，整支失敗、不會無聲略過
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const SETUP = `create role service_role; create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key, email text, created_at timestamptz default now());
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid, bucket_id text, name text); alter table storage.objects enable row level security;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
    create schema cron; create table cron.job(jobid serial, jobname text, schedule text, command text);
    create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job(jobname,schedule,command) values (n,s,c) returning jobid::bigint $$;
    create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname=n returning true $$;`

/** 套 migration：skipNew 為真就不套本 migration（拿「改前」的資料庫） */
async function boot({ skipNew = false } = {}) {
  const db = track(new PGlite())
  await db.exec(SETUP)
  for (const f of files) { if (skipNew && f === MIG) continue; await db.exec(read(f)) }
  return db
}

/** 所有 relay／public 函式的定義、授權、擁有者。key＝帶參數型別的簽章 */
async function snapshot(db) {
  const r = await db.query(`select p.oid::regprocedure::text sig, pg_get_functiondef(p.oid) d, p.proacl::text acl, pg_get_userbyid(p.proowner) owner,
      p.prosecdef secdef, p.provolatile vol, p.proconfig::text cfg, p.prosrc src,
      has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth,
      has_function_privilege('service_role', p.oid, 'execute') svc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('relay', 'public') and p.prokind = 'f' order by 1`)
  return new Map(r.rows.map(x => [x.sig, x]))
}
const strip = x => { const { sig: _s, ...rest } = x; return rest }

test('等價證明：改後函式定義 ＝ 改前把在線門檻換成 relay.online_window()；清單外一字不動；授權不變', { skip }, async () => {
  const db = await boot({ skipNew: true })
  const before = await snapshot(db)
  assert.equal(before.has('relay.online_window()'), false, '改前沒有 online_window')
  await db.exec(read(MIG))
  const after = await snapshot(db)

  // (ii) 函式集合：只多一個 online_window
  assert.deepEqual([...after.keys()].filter(k => !before.has(k)), ['relay.online_window()'])
  assert.deepEqual([...before.keys()].filter(k => !after.has(k)), [], '沒有函式消失')

  let replaced = 0
  for (const [sig, b] of before) {
    const a = after.get(sig)
    const exp = expectedAfter(b.d)
    assert.equal(exp.n, ONLINE_REPLACED[sig] ?? 0, `${sig}：被換掉的處數`)
    replaced += exp.n
    // (i) 逐函式字串相等（清單外的 exp.text 就是 b.d 本身，同時證明 (ii) 逐字不變）
    assert.equal(a.d, exp.text, `${sig}：改後定義 ＝ 改前換掉在線門檻`)
    if (!(sig in ONLINE_REPLACED)) assert.equal(a.d, b.d, `${sig}：清單外逐字不變`)
    // (iii) 授權、擁有者、security definer、volatility、SET 設定
    assert.deepEqual(strip({ ...a, d: 0, src: 0 }), strip({ ...b, d: 0, src: 0 }), `${sig}：授權／擁有者／屬性不變`)
  }
  assert.equal(replaced, ONLINE_TOTAL); assert.equal(ONLINE_TOTAL, 31)
  assert.equal(Object.keys(ONLINE_REPLACED).length, 18)
  for (const sig of Object.keys(ONLINE_REPLACED)) assert.equal(after.get(sig).secdef, true, `${sig} 仍是 security definer`)

  // online_window 自己的授權：只給 service_role，public／anon／authenticated 都沒有
  const w = after.get('relay.online_window()')
  assert.equal(w.anon, false); assert.equal(w.auth, false); assert.equal(w.svc, true)
  assert.doesNotMatch(w.acl, /(^|[{,])=/, 'public（空 grantee）沒有權限')
  assert.equal(w.secdef, false); assert.equal(w.vol, 'i'); assert.match(w.cfg, /search_path=.*""/)
  assert.match(w.d, /select interval '3 minutes'\s+-- online-window-definition/)
})

test('等價證明：資料庫裡所有函式本體的 3 分鐘字面量，除了白名單（online_window 本體、done_at、fg_at、created_at 逾時）全部消失', { skip }, async () => {
  const db = await boot({ skipNew: true })
  const count = snap => Object.fromEntries([...snap].map(([sig, x]) => [sig, (x.src.match(ANY_3MIN) ?? []).length]).filter(([, n]) => n))
  const before = count(await snapshot(db))
  assert.equal(Object.values(before).reduce((a, b) => a + b, 0), 37, '改前 20 個函式、37 處（盤點筆記的 15／31 是低估）')
  assert.equal(Object.keys(before).length, 20)
  await db.exec(read(MIG))
  assert.deepEqual(count(await snapshot(db)), LITERAL_WHITELIST)
  // 非函式物件（view、policy、排程）也不得有
  const other = await db.query(`select 'view:' || viewname n from pg_views where definition ~* '3 minutes'
    union all select 'policy:' || policyname from pg_policies where coalesce(qual, '') || coalesce(with_check, '') ~* '3 minutes'
    union all select 'cron:' || jobname from cron.job where command ~* '3 minutes'`)
  assert.deepEqual(other.rows, [])
})

test('回復：套 down 之後所有函式定義與改前逐字相同、online_window 被拿掉，可以再套回去', { skip }, async () => {
  const db = await boot({ skipNew: true })
  const before = await snapshot(db)
  await db.exec(read(MIG))
  const after = await snapshot(db)
  await db.exec(norm(fs.readFileSync(DOWN, 'utf8')))
  const down = await snapshot(db)
  assert.deepEqual([...down.keys()], [...before.keys()], '函式集合與改前相同（online_window 已 drop）')
  for (const [sig, b] of before) assert.deepEqual(down.get(sig), b, `${sig}：down 之後與改前逐字相同（含授權）`)
  const down2 = fs.readFileSync(DOWN, 'utf8').toLowerCase()
  assert.ok(down2.lastIndexOf('create or replace function') >= 0)
  assert.ok(down2.lastIndexOf('drop function relay.online_window()') > down2.lastIndexOf('create or replace function'), '先還原函式、最後才 drop online_window')
  await db.exec(read(MIG))
  const again = await snapshot(db)
  for (const [sig, a] of after) assert.deepEqual(again.get(sig), a, `${sig}：再套一次與第一次相同`)
})

// ---------------------------------------------------------------------------------------------------------------------
// 行為測試：用全部真實 migration，真的呼叫函式。2 分 58 秒前＝在線、3 分 02 秒前＝離線（兩邊各留 2 秒餘裕，避免機器忙時邊界抖動）。
const U1 = '11111111-1111-1111-1111-111111111111'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const IN = '2 minutes 58 seconds', OUT = '3 minutes 2 seconds'

async function world({ window: win = null } = {}) {
  const db = await boot()
  if (win) await db.exec(`create or replace function relay.online_window() returns interval language sql immutable set search_path to '' as $$ select interval '${win}' $$`)
  await db.exec(`insert into auth.users(id, email) values ('${U1}', 'a@x.y');
    insert into relay.tenants(id, owner_user, owner_name) values ('${T1}', '${U1}', '擁有者');`)
  const q = async (t, a) => (await db.query(t, a)).rows
  const node = (id, o = {}) => db.query(
    `insert into relay.nodes(id, name, key_hash, bell_topic, kind, role, platform, tenant_id, owner_user, status, machine, last_seen_at, created_via)
     values ($1, $1, $2, $3, $4, $5, $6, $7, $8, 'active', 'm', case when $9::text is null then null else now() - $9::interval end, $10)`,
    [id, (o.kind === 'web' ? 'web:' : 'k-') + id, 'bell-' + id, o.kind ?? 'other', o.role ?? 'member', o.platform ?? null, T1, o.owner === undefined ? U1 : o.owner, o.seen ?? null, o.kind === 'web' ? 'web-login' : null])
  const presence = (n, win2, ago) => db.query(`insert into relay.asn_presence(node, window_name, version, status, updated_at) values ($1, $2, '0.2.80', 'online', now() - $3::interval)`, [n, win2, ago])
  const roster = (n, name, ago) => db.query(`insert into relay.roster(node, name, seen_at) values ($1, $2, now() - $3::interval)`, [n, name, ago])
  const alias = (await q(`select public.asn_person_alias($1) a`, [U1]))[0].a
  const send = async (from, to, agent = null) => (await q(`select public.asn_relay_send_core($1, '寄件窗', $2, $3, '內文', null) r`, [from, to, agent]))[0].r
  const rows = () => q(`select to_node, to_agent from relay.messages order by to_node, to_agent`)
  const list = async () => (await q(`select public.asn_relay_list($1, true) r`, [T1]))[0].r
  return { db, q, node, presence, roster, alias, send, rows, list }
}

// asn_relay_list：online／presence（nodes.last_seen_at）、agents／offline_agents（roster.seen_at）、asn（asn_presence.updated_at）三組各一個邊界
async function scenarioList(w, ago, wantOn) {
  await w.node('N1', { seen: ago })
  await w.roster('N1', '甲', ago)
  await w.presence('N1', 'ASN', ago)
  const n = (await w.list()).find(x => x.id === 'N1')
  assert.equal(n.online, wantOn, `list.online（${ago}）`)
  assert.equal(n.presence, wantOn ? 'live' : 'recent', `list.presence（${ago}）`)
  assert.deepEqual(n.agents.map(a => a.name), wantOn ? ['甲'] : [], `list.agents（${ago}）`)
  assert.deepEqual(n.offline_agents.map(a => a.name), wantOn ? [] : ['甲'], `list.offline_agents（${ago}）`)
  assert.equal(n.asn.length, wantOn ? 1 : 0, `list.asn（${ago}）`)
}

// send_core：(1) 寄給本人位址，扇出給在線 ASN 視窗（桌機），(2) 手機（前一段在線＝進分送名單；離線＝走「留一列」）、(3) 網頁車道 web_lane_targets
async function scenarioSend(w, ago, wantOn) {
  await w.node('AI', { kind: 'claude' })
  await w.node('PC', { platform: 'windows' })
  await w.presence('PC', 'ASN', ago)
  const r = await w.send('AI', w.alias)
  assert.equal(r.fanout, wantOn ? 1 : 0, `send_core 桌機在線分送（${ago}）`)
  const rows = await w.rows()
  assert.equal(rows.length, 1, '只有一列')
  if (wantOn) assert.equal(rows[0].to_node, 'PC', '桌機在線：分送給它')
  else assert.notEqual(rows[0].to_node, 'PC', '桌機不在線：不分送給它（留一列給帳號名下最早的節點）')
}
async function scenarioSendPhone(w, ago, wantOn) {
  await w.node('AI', { kind: 'claude' })
  await w.node('PH', { platform: 'android' })
  await w.presence('PH', 'ASN', ago)
  const r = await w.send('AI', w.alias)
  // 手機在線：進分送名單（fanout 1）；離線（3 分鐘以上、30 天內）：不算分送，但「留一列」仍會有一列給它
  assert.equal(r.fanout, wantOn ? 1 : 0, `send_core 手機（${ago}）`)
  assert.deepEqual((await w.rows()).map(x => x.to_node), wantOn ? ['PH'] : ['AI', 'PH'], '在線：只分送給手機；離線：原收件列＋留給手機的一列')
}
async function scenarioSendWeb(w, ago, wantOn) {
  await w.node('AI', { kind: 'claude' })
  await w.node('PH', { platform: 'android' })
  await w.presence('PH', 'ASN', '1 day')
  await w.node('W1', { kind: 'web', platform: 'web' })
  await w.presence('W1', 'web', ago)
  await w.send('AI', w.alias)
  assert.deepEqual((await w.rows()).filter(x => x.to_node === 'W1').map(x => x.to_agent), wantOn ? ['web'] : [], `web_lane_targets（${ago}）`)
}
// 保底：寄給租戶本人的主節點（role=owner）且沒指定視窗；該節點上沒有在線 ASN 才改寄本人位址
async function scenarioSendOwnerNode(w, ago, wantOn) {
  await w.node('AI', { kind: 'claude' })
  await w.node('OWN', { role: 'owner' })
  await w.presence('OWN', 'ASN', ago)
  await w.send('AI', 'OWN')
  const own = (await w.rows()).find(x => x.to_node === 'OWN')
  assert.equal(own.to_agent, wantOn ? null : w.alias, `send_core 本人主節點保底（${ago}）`)
}

// messages_resolve_partner：舊名字的信，名字還有在線視窗就照舊；視窗不在線才轉寄給夥伴現名。整段包在 exception when others then null，壞了不報錯
async function scenarioResolve(w, ago, wantOn) {
  await w.node('N1'); await w.node('N2')
  const S = 'sess-0001-aaaa'
  const sync = async ws => (await w.q(`select public.asn_relay_partner_sync($1, $2::jsonb) r`, ['N1', JSON.stringify(ws)]))[0].r
  await sync([{ name: '甲', session_id: S }])
  await sync([{ name: '乙', session_id: S }])          // 同 session 改名 甲 → 乙
  await w.roster('N1', '甲', ago)                       // 舊名字「甲」在名單上，最後回報 ago 之前
  const m = (await w.q(`insert into relay.messages(tenant_id, from_node, from_agent, to_node, to_agent, body) values ($1, 'N2', '對方', 'N1', '甲', 'hi')
    returning to_agent, forwarded_from`, [T1]))[0]
  if (wantOn) assert.deepEqual(m, { to_agent: '甲', forwarded_from: null }, `舊名字還在線，不轉寄（${ago}）`)
  else assert.deepEqual(m, { to_agent: '乙', forwarded_from: '甲' }, `舊名字不在線，轉寄給現名（${ago}）`)
}

const SCENARIOS = { scenarioList, scenarioSend, scenarioSendPhone, scenarioSendWeb, scenarioSendOwnerNode, scenarioResolve }
async function runAll(opts) {
  for (const [name, fn] of Object.entries(SCENARIOS)) {
    for (const [ago, on] of [[IN, true], [OUT, false]]) {
      try { await fn(await world(opts), ago, on) } catch (e) { e.message = `${name}（${ago}）：${e.message}`; throw e }
    }
  }
}

test('行為：asn_relay_list 的 online／presence／agents／offline_agents／asn，2:58 在線、3:02 離線', { skip }, async () => {
  for (const [ago, on] of [[IN, true], [OUT, false]]) await scenarioList(await world(), ago, on)
})
test('行為：asn_relay_send_core——桌機在線分送、手機在線與離線、網頁車道、本人主節點保底（2:58／3:02）', { skip }, async () => {
  for (const [ago, on] of [[IN, true], [OUT, false]]) {
    await scenarioSend(await world(), ago, on)
    await scenarioSendPhone(await world(), ago, on)
    await scenarioSendWeb(await world(), ago, on)
    await scenarioSendOwnerNode(await world(), ago, on)
  }
})
test('行為：messages_resolve_partner——舊名字在線不轉寄、不在線真的轉寄給現名（2:58／3:02）', { skip }, async () => {
  for (const [ago, on] of [[IN, true], [OUT, false]]) await scenarioResolve(await world(), ago, on)
})

test('還原驗證：online_window() 被改成 0 秒或 1 小時，上面的行為測試每一條都會變紅', { skip }, async () => {
  for (const win of ['0 seconds', '1 hour']) {
    for (const [name, fn] of Object.entries(SCENARIOS)) {
      // 0 秒：在線的案例變離線；1 小時：離線的案例變在線。各取會被打到的那一邊，必須讓斷言失敗
      const [ago, on] = win === '0 seconds' ? [IN, true] : [OUT, false]
      await assert.rejects(async () => fn(await world({ window: win }), ago, on), e => e instanceof assert.AssertionError, `${name} 在 online_window＝${win} 時要因斷言變紅（不是別的錯誤）`)
    }
  }
  // 對照：不改壞時同一批案例是綠的（上面三個行為測試已證明，這裡再跑一次整批確認 runAll 本身可用）
  await runAll()
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
