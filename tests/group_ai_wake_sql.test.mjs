// 群組：AI 之間互相叫醒的輪數上限（migration 20261023190000_group_ai_wake_limit.sql）。
// 1. 靜態：交易內、不刪資料、新函式只授權 service_role。
// 2. 實跑（需要 @electric-sql/pglite）：套全部 migrations 後驗證
//    - 預設 5 輪：真人發言後，AI 點名 AI 的前 5 則叫醒，第 6 則起 suppressed 並對被點名者 wake_ok=false
//    - 真人再發言就重新起算；沒點名 AI 的 AI 訊息、點名真人的 AI 訊息不算一輪
//    - 上限 0：AI 完全不能叫醒 AI，真人點名 AI 照常
//    - 帳號設定可調（asn_account_settings：預設 5、0～20、其他 bad_request）
//    - 跨租戶群組用「主持人」帳號的設定，不是發言者的
// 3. 還原驗證：拿掉 room_post 的上限檢查、或拿掉「真人發言重置」，對應測試要變紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261023190000_group_ai_wake_limit.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：在交易內、不刪資料、只授權 service_role；room_post 簽章不變', () => {
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|delete from|truncate|drop function/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.match(sql, /grant execute on function public\.asn_account_settings\(uuid, integer\) to service_role;/)
  assert.match(sql, /asn_relay_room_post\(p_node text, p_agent text, p_room text, p_body text, p_mentions text\[\], p_owner boolean DEFAULT false, p_signed_user uuid DEFAULT NULL::uuid\)/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111' // 主持人
const U2 = '22222222-2222-2222-2222-222222222222' // 受邀的人
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const P1 = 'phn7a1', W1 = 'wrk9b2', Q2 = 'qqq3c4'
const A = `${W1}~財務`, B = `${W1}~w1`, C = `${W1}~w2`

async function boot({ mutate } = {}) {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key, email text, created_at timestamptz default now());
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid, bucket_id text, name text); alter table storage.objects enable row level security;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
    create schema cron; create table cron.job(jobid serial, jobname text, schedule text, command text);
    create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job(jobname,schedule,command) values (n,s,c) returning jobid::bigint $$;
    create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname=n returning true $$;`)
  for (const f of files) {
    let sql = read(f)
    if (mutate && mutate[f]) sql = mutate[f](sql)
    await db.exec(sql)
  }
  await db.exec(`
    insert into auth.users(id, email) values ('${U1}', 'a@x.y'), ('${U2}', 'b@x.y');
    insert into relay.tenants(id, owner_user, owner_name) values ('${T1}', '${U1}', '小良'), ('${T2}', '${U2}', '財務員');
    insert into relay.nodes(id, name, key_hash, bell_topic, role, tenant_id, owner_user, status, machine) values
      ('${P1}', '小良的手機', 'k1', 'bell-p1', 'member', '${T1}', '${U1}', 'active', '手機'),
      ('${W1}', '工作機', 'k2', 'bell-w1', 'member', '${T1}', '${U1}', 'active', '工作機'),
      ('${Q2}', '財務室電腦', 'k3', 'bell-q2', 'member', '${T2}', '${U2}', 'active', '電腦');
    insert into relay.roster(node, name, engine) values ('${W1}', '財務', 'claude'), ('${W1}', 'w1', 'claude'), ('${W1}', 'w2', 'claude'),
      ('${Q2}', '助理', 'claude');`)
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`
  return (await db.query(sql, keys.map(k => args[k]))).rows[0].r
}
const q = async (db, text, a = []) => (await db.query(text, a)).rows
const post = (db, { node, agent = null, room, body, mentions = [], signed = null }) =>
  rpc(db, 'asn_relay_room_post', { p_node: node, p_agent: agent, p_room: room, p_body: body, p_mentions: mentions, p_owner: false, p_signed_user: signed })
const readAs = (db, { node, agent = null, room, signed = null }) =>
  rpc(db, 'asn_relay_group_read', { p_node: node, p_agent: agent, p_room: room, p_since: null, p_limit: 200, p_owner: false, p_tail: true, p_mark: false, p_signed_user: signed })
const aiPost = (db, room, from, body, mentions) => post(db, { node: W1, agent: from.split('~')[1], room, body, mentions })
const human = (db, room, body, mentions = []) => post(db, { node: P1, room, signed: U1, body, mentions })
const setLimit = (db, user, n) => rpc(db, 'asn_account_settings', { p_user: user, p_ai_wake_limit: n })

async function oneTenantRoom(db) {
  const g = await rpc(db, 'asn_relay_group_create', { p_user: U1, p_node: P1, p_name: '接力', p_ai: [A, B, C] })
  assert.ok(g.id, JSON.stringify(g))
  return g.id
}

test('實跑：預設 5 輪——前 5 則 AI 點名 AI 會叫醒，第 6 則起不叫醒且被點名者讀到 wake_ok=false', { skip }, async () => {
  const db = await boot()
  const room = await oneTenantRoom(db)
  assert.deepEqual(await rpc(db, 'asn_account_settings', { p_user: U1 }), { ai_wake_limit: 5 }, '沒設定＝5')
  await human(db, room, '大家接力討論', [A])
  for (let i = 1; i <= 5; i++) {
    const r = await aiPost(db, room, i % 2 ? A : B, '第' + i + '輪', [i % 2 ? B : A])
    assert.deepEqual(r.suppressed, [], '第 ' + i + ' 輪應叫醒'); assert.equal(r.wake_limited, false)
  }
  const r6 = await aiPost(db, room, B, '第6輪', [A])
  assert.deepEqual(r6.suppressed, [A]); assert.equal(r6.wake_limited, true)
  const rd = await readAs(db, { node: W1, agent: '財務', room })
  assert.equal(rd.messages.find(m => m.body === '第6輪').wake_ok, false)
  assert.equal(rd.messages.find(m => m.body === '第5輪').wake_ok, true)
  // 第 7 則同樣擋，而且被擋的不佔叫醒額度
  assert.deepEqual((await aiPost(db, room, A, '第7輪', [B])).suppressed, [B])
  assert.equal((await q(db, `select count(*)::int n from relay.room_wakes`))[0].n, 0, '同租戶本來就不記叫醒額度')
})

test('實跑：真人發言就重新起算；沒點名 AI 的 AI 訊息、只點名真人的 AI 訊息不算一輪', { skip }, async () => {
  const db = await boot()
  const room = await oneTenantRoom(db)
  await human(db, room, '開始', [A])
  for (let i = 0; i < 5; i++) await aiPost(db, room, A, '來回' + i, [B])
  assert.equal((await aiPost(db, room, B, '被擋', [A])).wake_limited, true)
  await human(db, room, '我再說一句') // 沒點名也算真人發言
  const r = await aiPost(db, room, B, '重新起算', [A])
  assert.deepEqual(r.suppressed, [], '真人發言後重算')
  // 不算一輪的訊息：沒點名、點名真人
  const db2 = await boot()
  const room2 = await oneTenantRoom(db2)
  await human(db2, room2, '開始')
  for (let i = 0; i < 4; i++) await aiPost(db2, room2, A, '旁白' + i, [])
  for (let i = 0; i < 4; i++) await aiPost(db2, room2, A, '回報' + i, ['~u:' + U1])
  for (let i = 0; i < 5; i++) assert.deepEqual((await aiPost(db2, room2, A, '真接力' + i, [B])).suppressed, [], '第 ' + (i + 1) + ' 輪')
  assert.equal((await aiPost(db2, room2, A, '第六', [B])).wake_limited, true)
  // AI 擋住時，點名真人照常（不是 AI 就不在 suppressed）
  const mixed = await aiPost(db2, room2, A, '混合', [B, '~u:' + U1])
  assert.deepEqual(mixed.suppressed, [B])
})

test('實跑：上限 0——AI 完全不能叫醒 AI；真人點名 AI 照常叫醒', { skip }, async () => {
  const db = await boot()
  const room = await oneTenantRoom(db)
  assert.deepEqual(await setLimit(db, U1, 0), { ai_wake_limit: 0 })
  const h = await human(db, room, '請財務處理', [A])
  assert.deepEqual(h.suppressed, [])
  assert.equal((await readAs(db, { node: W1, agent: '財務', room })).messages.find(m => m.body === '請財務處理').wake_ok, true)
  const r = await aiPost(db, room, A, '我找 w1', [B])
  assert.deepEqual(r.suppressed, [B])
})

test('實跑：帳號設定——預設 5、可調 0～20、超出或不是整數 bad_request、查無帳號 not_found；調了立刻生效', { skip }, async () => {
  const db = await boot()
  assert.deepEqual(await rpc(db, 'asn_account_settings', { p_user: U1 }), { ai_wake_limit: 5 })
  assert.deepEqual(await setLimit(db, U1, 20), { ai_wake_limit: 20 })
  assert.deepEqual(await rpc(db, 'asn_account_settings', { p_user: U1 }), { ai_wake_limit: 20 })
  assert.equal((await setLimit(db, U1, 21)).error, 'bad_request')
  assert.equal((await setLimit(db, U1, -1)).error, 'bad_request')
  assert.deepEqual(await rpc(db, 'asn_account_settings', { p_user: U1 }), { ai_wake_limit: 20 }, '壞值不改')
  assert.equal((await rpc(db, 'asn_account_settings', { p_user: '99999999-9999-9999-9999-999999999999' })).error, 'not_found')
  assert.equal((await rpc(db, 'asn_account_settings', { p_user: null })).error, 'bad_request')
  // 改成 2：第 3 則起擋（被擋的也算一輪）；改成 4：再多放一則
  const room = await oneTenantRoom(db)
  await setLimit(db, U1, 2)
  await human(db, room, '開始')
  await aiPost(db, room, A, 'a', [B]); await aiPost(db, room, B, 'b', [A])
  assert.equal((await aiPost(db, room, A, 'c', [B])).wake_limited, true)
  await setLimit(db, U1, 4)
  assert.equal((await aiPost(db, room, A, 'd', [B])).wake_limited, false)
  // 其他設定不被覆蓋
  await db.exec(`update relay.tenants set features = features || '{"x":1}'::jsonb where id = '${T1}'`)
  await setLimit(db, U1, 7)
  assert.equal((await q(db, `select features->>'x' x from relay.tenants where id = '${T1}'`))[0].x, '1')
})

test('實跑：跨租戶群組用主持人帳號的設定，不看發言者的', { skip }, async () => {
  const db = await boot()
  const g = await rpc(db, 'asn_relay_group_create', { p_user: U1, p_node: P1, p_name: '跨租戶', p_ai: [A, B] })
  const code = 'code-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  const { createHash } = await import('node:crypto')
  const h = createHash('sha256').update(code).digest('hex')
  await rpc(db, 'asn_relay_group_invite_create', { p_user: U1, p_node: P1, p_kind: 'room', p_room: g.id, p_src_node: null, p_src_agent: null, p_seed: null, p_code_hash: h })
  assert.ok((await rpc(db, 'asn_relay_group_invite_accept', { p_user: U2, p_node: Q2, p_code_hash: h })).room_id)
  assert.equal((await rpc(db, 'asn_relay_group_ai_add', { p_user: U2, p_node: Q2, p_room: g.id, p_keys: [`${Q2}~助理`] })).added, 1)
  const room = g.id
  const members = await rpc(db, 'asn_relay_group_members', { p_node: Q2, p_agent: null, p_room: room, p_owner: false, p_signed_user: U2 })
  const refA = members.members.find(m => m.name === '財務').key
  const guestAi = (body, mentions) => post(db, { node: Q2, agent: '助理', room, body, mentions })
  // 受邀者把自己的上限設成 0，主持人沒設（5）→ 以主持人為準，客人的 AI 仍可叫醒
  await setLimit(db, U2, 0)
  await post(db, { node: Q2, room, signed: U2, body: '財務員發話', mentions: [refA] })
  assert.deepEqual((await guestAi('助理點名財務', [refA])).suppressed, [], '客人設 0 無效，看主持人')
  // 主持人把上限設成 1：下一則被擋（主持人設定生效）；客人設成 20 也沒用
  await setLimit(db, U1, 1); await setLimit(db, U2, 20)
  assert.deepEqual((await guestAi('第二輪', [refA])).suppressed, [A])
  // 真人（客人本人）發言也會重置
  await post(db, { node: Q2, room, signed: U2, body: '我說話', mentions: [] })
  assert.deepEqual((await guestAi('重算', [refA])).suppressed, [])
})

// ===== 還原驗證：拿掉被守的東西，測試要變紅 =====
const runReverts = async (name, mutate, expectRed) => {
  if (skip) return
  const db = await boot({ mutate: { [MIG]: mutate } })
  const room = await oneTenantRoom(db)
  await human(db, room, '開始', [A])
  let blocked = false
  for (let i = 0; i < 6; i++) blocked = (await aiPost(db, room, A, 'x' + i, [B])).wake_limited
  assert.equal(blocked, expectRed, name)
}
test('還原驗證：拿掉 room_post 的上限檢查，第 6 則就不會被擋（上面的測試會紅）', { skip }, async () => {
  await runReverts('原樣', s => s, true)
  await runReverts('拿掉上限檢查', s => s.replace('if not v_human and relay.room_ai_chain_blocked(p_room, v_key) then', 'if false then'), false)
})
test('還原驗證：拿掉「真人發言重置」，真人發言後仍被擋', { skip }, async () => {
  const mutate = s => s.replace(/and m\.seq > coalesce\(\(select max\(h\.seq\)[\s\S]*?, 0\)\n/, '\n')
  assert.notEqual(mutate(read(MIG)), read(MIG), '改寫有生效')
  const db = await boot({ mutate: { [MIG]: mutate } })
  const room = await oneTenantRoom(db)
  await human(db, room, '開始')
  for (let i = 0; i < 5; i++) await aiPost(db, room, A, 'x' + i, [B])
  await human(db, room, '真人再說')
  assert.equal((await aiPost(db, room, A, 'y', [B])).wake_limited, true, '拿掉重置後仍被擋＝重置測試會紅')
})
