// 手機確認終端送字／代答（migration 20261026400000_term_requests.sql）。
// 1. 靜態：交易內、不刪資料、函式只給 service_role、表開 RLS 且不給 anon／authenticated。
// 2. 實跑（需要 @electric-sql/pglite；沒裝略過，pglite 測試不加 --test-force-exit）：
//    建立（只有桌面）、雜湊綁死、一次性、手機決定要本人簽章且節點是這個人的、他人／他租戶不行、
//    answer 的選項必須在桌面給的清單內、過期、同終端一筆、頻率上限、完成後預覽清空、內容清洗。
// 3. 還原驗證：拿掉雜湊比對或一次性條件，對應測試要變紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261026400000_term_requests.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：交易內、不刪資料、函式只給 service_role、表開 RLS', () => {
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|delete from|truncate|drop function/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.match(code, /alter table relay\.term_requests enable row level security/)
  assert.match(code, /revoke all on relay\.term_requests from public, anon, authenticated/)
  for (const f of ['create(text, text, text, text, text, boolean, jsonb, text)', 'list(text, uuid)', 'decide(text, uuid, uuid, text, integer, text)', 'take(text)', 'result(text, uuid, text, text)']) {
    assert.ok(code.includes(`grant execute on function public.asn_relay_term_req_${f} to service_role;`), f)
  }
  assert.ok(files.includes(MIG))
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const P1 = 'phn7a1', W1 = 'wrk9b2', Q2 = 'qqq3c4'
const H = 'a'.repeat(64), H2 = 'b'.repeat(64)

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
      ('${W1}', '家用機', 'k2', 'bell-w1', 'member', '${T1}', '${U1}', 'active', '工作機'),
      ('${Q2}', '財務室電腦', 'k3', 'bell-q2', 'member', '${T2}', '${U2}', 'active', '電腦');`)
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`
  return (await db.query(sql, keys.map(k => args[k]))).rows[0].r
}
const create = (db, o = {}) => rpc(db, 'asn_relay_term_req_create', { p_node: W1, p_kind: 'send', p_term_id: '3', p_folder_label: 'order-plus', p_preview: '回答 1', p_enter: true, p_options: null, p_hash: H, ...o })
const decide = (db, o = {}) => rpc(db, 'asn_relay_term_req_decide', { p_actor: P1, p_signed_user: U1, p_id: null, p_decision: 'approve', p_choice_n: null, p_hash: H, ...o })
const list = (db, o = {}) => rpc(db, 'asn_relay_term_req_list', { p_actor: P1, p_signed_user: U1, ...o })
const take = (db, node = W1) => rpc(db, 'asn_relay_term_req_take', { p_node: node })
const result = (db, id, status = 'done', node = W1) => rpc(db, 'asn_relay_term_req_result', { p_node: node, p_id: id, p_status: status, p_detail: '' })
const rowOf = async (db, id) => (await db.query(`select * from relay.term_requests where id = $1`, [id])).rows[0]
const OPTS = [{ n: 1, label: 'Yes, proceed' }, { n: 2, label: 'No, quit' }]

test('實跑：送字——桌面建立、手機列出並用相同雜湊確認、桌面領走、回報完成後預覽清空；一次性', { skip }, async () => {
  const db = await boot()
  const c = await create(db)
  assert.ok(c.id && c.bell_topic === 'bell-w1' && c.expires_at)
  const l = (await list(db)).requests
  assert.equal(l.length, 1)
  assert.deepEqual([l[0].id, l[0].node, l[0].kind, l[0].preview, l[0].enter, l[0].body_hash], [c.id, W1, 'send', '回答 1', true, H])
  assert.equal((await decide(db, { p_id: c.id, p_hash: H2 })).error, 'hash_mismatch', '雜湊不符不放行')
  assert.equal((await rowOf(db, c.id)).status, 'pending', '雜湊不符不改狀態')
  assert.deepEqual(await decide(db, { p_id: c.id }), { ok: true, status: 'approved' })
  assert.equal((await decide(db, { p_id: c.id })).error, 'not_found', '重複決定無效（一次性）')
  const t = (await take(db)).requests
  assert.equal(t.length, 1); assert.deepEqual([t[0].id, t[0].kind, t[0].term_id, t[0].body_hash, t[0].choice_n], [c.id, 'send', '3', H, null])
  assert.equal((await take(db)).requests.length, 0, '領走後不會再領到')
  assert.deepEqual(await result(db, c.id), { ok: true })
  const r = await rowOf(db, c.id)
  assert.equal(r.status, 'done'); assert.equal(r.preview, null); assert.equal(r.options, null, '完成後預覽與選項清空')
  assert.equal((await result(db, c.id)).error, 'not_found', '結案後不能再改')
})

test('實跑：手機只能決定——沒簽章、別人、別的租戶、不存在都被擋；手機不能建立在別人的節點上', { skip }, async () => {
  const db = await boot()
  const c = await create(db)
  assert.equal((await decide(db, { p_id: c.id, p_signed_user: null })).error, 'forbidden', '沒本人簽章')
  assert.equal((await decide(db, { p_id: c.id, p_actor: Q2, p_signed_user: U2 })).error, 'forbidden', '別的租戶的人決定不了')
  assert.equal((await decide(db, { p_id: c.id, p_actor: Q2, p_signed_user: U1 })).error, 'forbidden', '拿別人的節點當自己')
  assert.equal((await decide(db, { p_id: '99999999-9999-9999-9999-999999999999' })).error, 'not_found')
  assert.equal((await list(db, { p_signed_user: null })).error, 'forbidden')
  assert.equal((await list(db, { p_actor: Q2, p_signed_user: U2 })).requests.length, 0, '別的租戶看不到')
  assert.equal((await rowOf(db, c.id)).status, 'pending', '以上都沒動到請求')
  assert.equal((await create(db, { p_node: 'nobody' })).error, 'not_found', '不存在的節點不能建立')
})

test('實跑：拒絕會清掉預覽；桌面領取時看得到被拒絕的編號；拒絕後不能再同意', { skip }, async () => {
  const db = await boot()
  const c = await create(db)
  assert.deepEqual(await decide(db, { p_id: c.id, p_decision: 'deny' }), { ok: true, status: 'denied' })
  const r = await rowOf(db, c.id)
  assert.equal(r.status, 'denied'); assert.equal(r.preview, null)
  const t = await take(db)
  assert.equal(t.requests.length, 0); assert.deepEqual(t.closed, [{ id: c.id, status: 'denied' }])
  assert.equal((await decide(db, { p_id: c.id })).error, 'not_found')
})

test('實跑：代答——選項必須是桌面給的；送字不能帶選項；領取時帶回選的編號', { skip }, async () => {
  const db = await boot()
  assert.equal((await create(db, { p_kind: 'answer', p_options: null })).error, 'bad_request', '代答一定要有選項')
  assert.equal((await create(db, { p_kind: 'send', p_options: OPTS })).error, 'bad_request', '送字不能帶選項')
  assert.equal((await create(db, { p_kind: 'answer', p_options: [{ n: 1 }] })).error, 'bad_request')
  const c = await create(db, { p_kind: 'answer', p_term_id: '4', p_preview: 'Do you trust the contents of this directory?', p_options: OPTS, p_enter: false })
  assert.ok(c.id)
  assert.equal((await decide(db, { p_id: c.id, p_choice_n: 7 })).error, 'bad_choice', '不在選項裡')
  assert.equal((await decide(db, { p_id: c.id, p_choice_n: null })).error, 'bad_choice', '代答一定要選')
  assert.deepEqual(await decide(db, { p_id: c.id, p_choice_n: 1 }), { ok: true, status: 'approved' })
  const t = (await take(db)).requests
  assert.deepEqual([t[0].kind, t[0].choice_n], ['answer', 1])
  const s = await create(db, { p_term_id: '5' })
  assert.equal((await decide(db, { p_id: s.id, p_choice_n: 1 })).error, 'bad_choice', '送字不能帶選擇')
})

test('實跑：2 分鐘過期（預覽清空、不能再決定）；同一終端同時只有一筆；每小時最多 20 筆', { skip }, async () => {
  const db = await boot()
  const c = await create(db)
  assert.equal((await create(db)).error, 'busy', '同一終端未結案時不能再建')
  assert.ok((await create(db, { p_term_id: '9' })).id, '別的終端不受影響')
  await db.exec(`update relay.term_requests set expires_at = now() - interval '1 second' where id = '${c.id}'`)
  assert.equal((await decide(db, { p_id: c.id })).error, 'not_found', '過期不能決定')
  const r = await rowOf(db, c.id)
  assert.equal(r.status, 'expired'); assert.equal(r.preview, null)
  assert.ok((await create(db)).id, '舊的過期後同一終端又能建')
  const db2 = await boot()
  for (let i = 0; i < 20; i++) assert.ok((await create(db2, { p_term_id: `t${i}`, p_hash: H })).id, `第 ${i + 1} 筆`)
  assert.equal((await create(db2, { p_term_id: 'tx' })).error, 'rate_limited', '第 21 筆被擋')
  const db3 = await boot()
  const q = await create(db3)
  await db3.exec(`update relay.term_requests set status = 'approved' where id = '${q.id}'; update relay.term_requests set expires_at = now() - interval '1 second' where id = '${q.id}'`)
  assert.equal((await take(db3)).requests.length, 0, '已確認但過期的不會被領走')
})

test('實跑：內容清洗——控制字元換成空白、預覽最多 200 字、資料夾名最多 60 字；格式不對一律 bad_request', { skip }, async () => {
  const db = await boot()
  const c = await create(db, { p_preview: 'a\u001b[31mb\nc\td' + 'x'.repeat(300), p_folder_label: 'f\u0007' + 'y'.repeat(100) })
  const r = await rowOf(db, c.id)
  assert.ok(!/[\u0000-\u001f]/.test(r.preview) && r.preview.length === 200, r.preview)
  assert.ok(!/[\u0000-\u001f]/.test(r.folder_label) && r.folder_label.length === 60)
  for (const bad of [{ p_kind: 'rm' }, { p_term_id: '../x' }, { p_term_id: 'a'.repeat(17) }, { p_hash: 'xyz' }, { p_hash: 'A'.repeat(64) }, { p_preview: '   ' }, { p_preview: null }]) {
    assert.equal((await create(db, { p_term_id: 'z' + Math.random().toString(36).slice(2, 6), ...bad })).error, 'bad_request', JSON.stringify(bad))
  }
  assert.equal((await result(db, c.id, 'ok')).error, 'bad_request', '回報狀態只認 done／failed／cancelled')
  assert.equal((await result(db, c.id, 'done', Q2)).error, 'not_found', '別的節點不能回報這筆')
  assert.deepEqual(await result(db, c.id, 'cancelled'), { ok: true }, '本機先按了確認框＝取消')
})

test('還原驗證：拿掉雜湊比對、拿掉一次性條件，對應測試要變紅', { skip }, async () => {
  const noHash = await boot({ mutate: { [MIG]: s => s.replace("if p_hash is distinct from r.body_hash then", "if false then") } })
  const c = await create(noHash)
  assert.deepEqual(await decide(noHash, { p_id: c.id, p_hash: H2 }), { ok: true, status: 'approved' }, '拿掉比對後錯的雜湊也過＝雜湊測試有效')
  const reuse = await boot({ mutate: { [MIG]: s => s.replace("if not found or r.status <> 'pending' or r.expires_at <= now() then", "if not found then") } })
  const d = await create(reuse)
  await decide(reuse, { p_id: d.id })
  assert.equal((await decide(reuse, { p_id: d.id })).ok, true, '拿掉狀態條件後可以重複決定＝一次性測試有效')
})
