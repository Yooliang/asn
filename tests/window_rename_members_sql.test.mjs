// 視窗改名後群組成員跟著改名（#229，migration 20261024180000_window_rename_members.sql）。
// 1. 靜態：交易內、不刪資料、新函式只授權 service_role、時間戳夠新。
// 2. 實跑（需要 @electric-sql/pglite；沒裝略過，pglite 測試不加 --test-force-exit）：
//    - 明說改名後：仍是成員、可用新名發言、舊名不能；已讀位置／角色／加入時間／可見起點／allow_others／member_ref 不變；
//      歷史訊息的發言者與 @ 點名顯示新名；
//    - 別的租戶的人只看到 x:<代號>（改名前後同一個），內容裡沒有節點代號也沒有舊名；
//    - 衝突（新名已是同群組成員）不覆蓋、兩者都在；別的節點不能動我的視窗；壞名字被擋；重跑不再動；
//    - 夥伴同步判定的改名（同節點同 session）自動帶到群組；換 session（接班）不帶。
// 3. 還原驗證：拿掉「更新發言者鍵」、「衝突檢查」、「同 session 條件」，對應測試要變紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261024180000_window_rename_members.sql'
const MIG2 = '20261025020000_wake_info_follow_rename.sql'   // 重新定義 relay.window_rename_members（多改寫 wake_info），以它為準
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：在交易內、不刪資料、新函式只授權 service_role、時間戳夠新、檔案是 LF', () => {
  const raw = fs.readFileSync(new URL(MIG, DIR), 'utf8')
  // 換行以 git 內容為準（Windows 檢出會被 autocrlf 轉成 CRLF，那不算問題）；這裡只確認內容正規化後與讀入的一致
  assert.ok(raw.replace(/\r\n/g, '\n') === read(MIG))
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|delete from|truncate|drop function/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.match(sql, /grant execute on function public\.asn_relay_window_rename\(text, text, text\) to service_role;/)
  assert.ok(MIG > '20261024170000_ai_silent_wake.sql')
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const P1 = 'phn7a1', W1 = 'wrk9b2', Q2 = 'qqq3c4'
const A = `${W1}~財務`, B = `${W1}~管理`, A2 = `${W1}~會計`

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
    insert into relay.roster(node, name, engine) values ('${W1}', '財務', 'claude'), ('${W1}', '管理', 'claude'), ('${Q2}', '助理', 'claude');`)
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`
  return (await db.query(sql, keys.map(k => args[k]))).rows[0].r
}
const post = (db, { node, agent = null, room, body, mentions = [], signed = null }) =>
  rpc(db, 'asn_relay_room_post', { p_node: node, p_agent: agent, p_room: room, p_body: body, p_mentions: mentions, p_owner: false, p_signed_user: signed })
const readAs = (db, { node, agent = null, room, signed = null }) =>
  rpc(db, 'asn_relay_group_read', { p_node: node, p_agent: agent, p_room: room, p_since: null, p_limit: 200, p_owner: false, p_tail: true, p_mark: false, p_signed_user: signed })
const rename = (db, node, from, to) => rpc(db, 'asn_relay_window_rename', { p_node: node, p_from: from, p_to: to })
const sha = c => crypto.createHash('sha256').update(c).digest('hex')
const member = async (db, room, key) => (await db.query('select * from relay.room_members where room_id=$1 and member=$2', [room, key])).rows[0]
async function joinU2(db, room) {
  const code = 'code-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  const inv = await rpc(db, 'asn_relay_group_invite_create', { p_user: U1, p_node: P1, p_kind: 'room', p_room: room, p_src_node: null, p_src_agent: null, p_seed: null, p_code_hash: sha(code) })
  assert.ok(!inv.error, JSON.stringify(inv))
  const acc = await rpc(db, 'asn_relay_group_invite_accept', { p_user: U2, p_node: Q2, p_code_hash: sha(code) })
  assert.ok(!acc.error, JSON.stringify(acc))
}
async function setup(db) {
  const g = await rpc(db, 'asn_relay_group_create', { p_user: U1, p_node: P1, p_name: '財會組', p_ai: [A, B] })
  assert.ok(g.id, JSON.stringify(g))
  return g.id
}

test('實跑：改名後仍是同一位成員——可用新名發言、舊名不行；已讀位置與各項設定原樣保留；歷史發言者顯示新名、@ 點名跟著改', { skip }, async () => {
  const db = await boot()
  const room = await setup(db)
  await post(db, { node: P1, room, signed: U1, body: '開始' })
  const m1 = await post(db, { node: W1, agent: '財務', room, body: '我是第一則' })
  assert.ok(m1.seq, JSON.stringify(m1))
  await post(db, { node: W1, agent: '管理', room, body: '點名你', mentions: [A] })
  await db.exec(`update relay.room_members set read_seq = 2, visible_from_seq = 1, allow_others = false, role = 'admin' where room_id = '${room}' and member = '${A}'`)
  const before = await member(db, room, A)

  const r = await rename(db, W1, '財務', '會計')
  assert.deepEqual(r, { ok: true, moved: 1, conflicts: 0 })
  await db.exec(`insert into relay.roster(node, name, engine) values ('${W1}', '會計', 'claude') on conflict do nothing`)

  assert.equal(await member(db, room, A), undefined, '舊鍵不在了')
  const after = await member(db, room, A2)
  for (const k of ['read_seq', 'visible_from_seq', 'allow_others', 'role', 'joined_at', 'joined_via', 'member_ref', 'user_id', 'left_at']) {
    assert.deepEqual(after[k], before[k], k + ' 要保留')
  }
  assert.equal(after.display_name, '會計')
  const ok = await post(db, { node: W1, agent: '會計', room, body: '改名後我還能說話' })
  assert.ok(ok.seq && !ok.error, JSON.stringify(ok))
  const old = await post(db, { node: W1, agent: '財務', room, body: '舊名' })
  assert.ok(old.error, '舊名不再是成員')

  const rd = await readAs(db, { node: P1, room, signed: U1 })
  const mine = rd.messages.filter(m => m.from === A2)
  assert.equal(mine.length, 2, '歷史訊息的發言者鍵一起改')
  assert.ok(mine.every(m => m.from_name === '會計'))
  assert.ok(!rd.messages.some(m => m.from === A))
  const mention = rd.messages.find(m => m.body === '點名你')
  assert.deepEqual(mention.mentions, [A2])
  assert.equal((await rename(db, W1, '財務', '會計')).moved, 0, '重跑不再動')
})

test('實跑：別的租戶的人只看到不變的 x:<代號>，看不到節點代號、也看不到舊名', { skip }, async () => {
  const db = await boot()
  const room = await setup(db)
  await joinU2(db, room)
  await post(db, { node: W1, agent: '財務', room, body: '第一則' })
  const seeBefore = await readAs(db, { node: Q2, room, signed: U2 })
  const keyBefore = seeBefore.messages.find(m => m.body === '第一則').from
  assert.match(keyBefore, /^x:/)
  await rename(db, W1, '財務', '會計')
  await db.exec(`insert into relay.roster(node, name, engine) values ('${W1}', '會計', 'claude')`)
  const seeAfter = await readAs(db, { node: Q2, room, signed: U2 })
  const msg = seeAfter.messages.find(m => m.body === '第一則')
  assert.equal(msg.from, keyBefore, '對外代號不變')
  const text = JSON.stringify(seeAfter)
  assert.ok(!text.includes(W1), '不洩露節點代號')
  assert.ok(!/(from_name|from_label)":"財務[（"]/.test(text), '舊名不出現在發言者')
  assert.ok(!seeAfter.messages.some(m => m.from_kind === 'system' && /改名/.test(m.body)), '不送含舊名的系統訊息')
})

test('實跑：新名已是同群組成員時不覆蓋、兩者都留；只動自己節點；壞名字被擋', { skip }, async () => {
  const db = await boot()
  const room = await setup(db)
  await db.exec(`insert into relay.room_members(room_id, member, display_name) values ('${room}', '${A2}', '舊會計') on conflict do nothing`)
  await post(db, { node: W1, agent: '財務', room, body: '財務說的' })
  const r = await rename(db, W1, '財務', '會計')
  assert.deepEqual(r, { ok: true, moved: 0, conflicts: 1 })
  assert.ok(await member(db, room, A) && await member(db, room, A2), '兩者都在')
  assert.equal((await member(db, room, A2)).display_name, '舊會計', '不覆蓋')
  const rd = await readAs(db, { node: P1, room, signed: U1 })
  assert.equal(rd.messages.find(m => m.body === '財務說的').from, A, '歷史不動')
  // 別的節點不能動我的視窗：Q2 用同一組名字只會找 Q2~財務
  assert.equal((await rename(db, Q2, '財務', '偷名')).moved, 0)
  assert.ok(await member(db, room, A))
  assert.ok((await rename(db, W1, 'a~b', 'c')).error)
  assert.ok((await rename(db, W1, 'a', 'a')).error)
  assert.ok((await rename(db, W1, 'a', '')).error)
  assert.equal((await rename(db, 'nobody', 'a', 'b')).error, 'forbidden')
})

test('實跑：自訂的顯示名不被改名覆蓋', { skip }, async () => {
  const db = await boot()
  const room = await setup(db)
  await db.exec(`update relay.room_members set display_name = '大財務' where room_id = '${room}' and member = '${A}'`)
  await rename(db, W1, '財務', '會計')
  assert.equal((await member(db, room, A2)).display_name, '大財務')
})

test('實跑：夥伴同步判定的改名（同節點同 session）自動帶到群組；換 session 的接班不帶', { skip }, async () => {
  const db = await boot()
  const room = await setup(db)
  await db.exec(`insert into relay.partners(partner_id, tenant_id, node, current_name, current_session)
    values ('p_00000000000000000001', '${T1}', '${W1}', '財務', 'sess-aaaaaaaa')`)
  await db.exec(`update relay.partners set current_name = '會計' where partner_id = 'p_00000000000000000001'`)
  assert.ok(await member(db, room, A2), '同 session 改名帶到群組')
  assert.equal(await member(db, room, A), undefined)
  // 接班：名字與 session 一起變，不算改名
  await db.exec(`update relay.partners set current_name = '新人', current_session = 'sess-bbbbbbbb' where partner_id = 'p_00000000000000000001'`)
  assert.ok(await member(db, room, A2), '接班不動')
  assert.equal(await member(db, room, `${W1}~新人`), undefined)
})

test('還原驗證：拿掉各項保護，對應測試要變紅', { skip }, async () => {
  const runs = [
    ['不改歷史發言者', s => s.replace(/    update relay\.room_messages set from_member = v_new[^\n]*\n/, ''), async db => {
      const room = await setup(db)
      await post(db, { node: W1, agent: '財務', room, body: 'x' })
      await rename(db, W1, '財務', '會計')
      const rd = await readAs(db, { node: P1, room, signed: U1 })
      assert.equal(rd.messages.filter(m => m.from === A2).length, 1)
    }],
    ['沒有衝突檢查', s => s.replace(/if exists \(select 1 from relay\.room_members x[^]*?end if;\n/, ''), async db => {
      const room = await setup(db)
      await db.exec(`insert into relay.room_members(room_id, member) values ('${room}', '${A2}')`)
      const r = await rename(db, W1, '財務', '會計')
      assert.deepEqual(r, { ok: true, moved: 0, conflicts: 1 })
    }],
    ['不改叫醒順序的成員鍵', s => s.replace(/    update relay[.]room_messages set wake_info = [^\n]*\n/, ''), async db => {
      const room = await setup(db)
      await post(db, { node: W1, agent: '財務', room, body: 'x' })
      await db.exec(`update relay.room_messages set wake_info = '[{"m":"${A}","rank":1,"hold":false}]'::jsonb where room_id = '${room}'`)
      await rename(db, W1, '財務', '會計')
      const w = (await db.query(`select wake_info from relay.room_messages where room_id = '${room}' and wake_info is not null`)).rows[0].wake_info
      assert.equal(w[0].m, A2)
    }],
    ['不看 session 條件', s => s.replace(/\n     and old\.node = new\.node and old\.current_session is not distinct from new\.current_session then/, '\n     and old.node = new.node then'), async db => {
      const room = await setup(db)
      await db.exec(`insert into relay.partners(partner_id, tenant_id, node, current_name, current_session)
        values ('p_00000000000000000001', '${T1}', '${W1}', '財務', 'sess-aaaaaaaa')`)
      await db.exec(`update relay.partners set current_name = '新人', current_session = 'sess-bbbbbbbb' where partner_id = 'p_00000000000000000001'`)
      assert.equal(await member(db, room, `${W1}~新人`), undefined)
    }],
  ]
  for (const [name, mut, body] of runs) {
    const good = await boot()
    await body(good) // 原版要綠
    const bad = await boot({ mutate: { [MIG]: mut, [MIG2]: mut } })
    if (mut(read(MIG)) === read(MIG) && mut(read(MIG2)) === read(MIG2)) assert.fail(name + '：還原的取代沒有生效（樣式沒對到）')
    await assert.rejects(() => body(bad), undefined, name + '：拿掉後測試應該變紅')
  }
})
