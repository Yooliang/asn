// 遠端一次性密碼傳遞 migration（20261023060000_secret_remote.sql）：
// 1. 靜態檢查：只給 service_role、security definer＋search_path ''、RLS 開且沒有 policy、公鑰唯一、密文欄位只放格式合格的字串。
// 2. 實跑檢查：有安裝 @electric-sql/pglite 時（不是專案相依，自己 `npm i --no-save @electric-sql/pglite`）在記憶體內的 Postgres 套用 migration：
//    請求（主人、有效期限範圍、公鑰唯一＝重放保護、同時上限、每小時上限）、待確認（只回公鑰與說明、不含密文、只回自己的）、
//    回覆（非本人不能回、一次性、過期不能回、拒絕）、取回（只有請求端、只能取一次、取走後密文清掉、過期取不到）、過期自動清。沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = fs.readFileSync(new URL('../supabase/migrations/20261023060000_secret_remote.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('靜態：五個函式 security definer、search_path 空、只授權 service_role；資料表開 RLS 且不建 policy', () => {
  for (const sig of ['asn_relay_secret_purge\\(\\)', 'asn_relay_secret_request\\(text, text, text, text, integer\\)', 'asn_relay_secret_pending\\(text, uuid\\)',
    'asn_relay_secret_reply\\(text, uuid, uuid, text, boolean\\)', 'asn_relay_secret_fetch\\(text, uuid\\)']) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${sig} from public, anon, authenticated;`), sig)
    assert.match(sql, new RegExp(`grant execute on function public\\.${sig} to service_role;`), sig)
  }
  assert.equal((sql.match(/security definer\nset search_path to ''/g) ?? []).length, 5)
  assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.match(sql, /alter table relay\.secret_requests enable row level security;/)
  assert.match(sql, /revoke all on relay\.secret_requests from public, anon, authenticated;/)
  assert.doesNotMatch(sql, /create policy/)
  assert.match(sql, /create unique index if not exists secret_requests_pub_uq on relay\.secret_requests \(pub\);/)
  assert.match(sql, /cipher ~ '\^\[A-Za-z0-9_-\]\+\$'/)
})

test('靜態：回覆要本人簽章且擁有回覆設備與請求端節點；取回只認請求端；函式名都是 asn_relay_ 新名', () => {
  const reply = sql.slice(sql.indexOf('function public.asn_relay_secret_reply('), sql.indexOf('function public.asn_relay_secret_fetch('))
  assert.match(reply, /asn_user_owns_node\(p_signed_user, p_actor\)/)
  assert.match(reply, /asn_user_owns_node\(p_signed_user, requester_node\)/)
  assert.match(reply, /owner_user = p_signed_user/)
  assert.doesNotMatch(reply, /role = 'owner'/)
  const fetch = sql.slice(sql.indexOf('function public.asn_relay_secret_fetch('), sql.indexOf('revoke all on function public.asn_relay_secret_purge'))
  assert.match(fetch, /requester_node = p_node/)
  assert.match(fetch, /set status = 'delivered', cipher = null/)
  assert.doesNotMatch(sql, /irori_relay_/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const T2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const NOID = '33333333-3333-3333-3333-333333333333'
const pub = n => String(n).padStart(43, 'P')
// 假密文：只是長度與字元集合格
const CIPHER = 'FAKEcipher_' + 'x'.repeat(200)

async function boot() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', owner_user uuid, name text, bell_topic text);
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable as
      $$ select p_user is not null and exists (select 1 from relay.nodes n where n.id = p_node and n.status = 'active' and n.owner_user = p_user) $$;
    insert into relay.nodes(id, tenant_id, owner_user, name, bell_topic) values
      ('CLOUD','${T1}','${U1}','雲端代理','bell-CLOUD'),
      ('PC','${T1}','${U1}','家用機','bell-PC'),
      ('PHONE','${T1}','${U1}','手機','bell-PHONE'),
      ('OTHER','${T2}','${U2}','別人的電腦','bell-OTHER'),
      ('STRAY','${T1}',null,'沒綁帳號','bell-STRAY');`)
  await db.exec(sql)
  const one = async (text, args) => (await db.query(text, args)).rows[0]
  const request = async (o = {}) => (await one('select public.asn_relay_secret_request($1,$2,$3,$4,$5) r',
    [o.node ?? 'CLOUD', o.pub ?? pub(1), o.program ?? 'git.exe', o.purpose ?? 'git push', 'ttl' in o ? o.ttl : 180])).r
  const pending = async (actor = 'PC', user = U1) => (await one('select public.asn_relay_secret_pending($1,$2) r', [actor, user])).r
  const reply = async (o = {}) => (await one('select public.asn_relay_secret_reply($1,$2,$3,$4,$5) r',
    [o.actor ?? 'PC', o.user === undefined ? U1 : o.user, o.id, o.cipher === undefined ? CIPHER : o.cipher, o.deny ?? false])).r
  const fetch = async (node, id) => (await one('select public.asn_relay_secret_fetch($1,$2) r', [node, id])).r
  return { db, one, request, pending, reply, fetch, q: async (t, a) => (await db.query(t, a)).rows }
}

test('實跑（pglite）：請求——節點要有主人、公鑰唯一（重放）、有效期限範圍、同時上限、每小時上限；門鈴只給本人其他設備', { skip }, async () => {
  const { request, q, db } = await boot()
  const ok = await request()
  assert.ok(ok.id)
  assert.deepEqual([...ok.bell_topics].sort(), ['bell-PC', 'bell-PHONE'], '本人其他設備，不含自己、別人、沒綁帳號的')
  const row = (await q('select requester_node, owner_user, tenant_id, status, cipher, program, purpose from relay.secret_requests where id = $1', [ok.id]))[0]
  assert.deepEqual(row, { requester_node: 'CLOUD', owner_user: U1, tenant_id: T1, status: 'pending', cipher: null, program: 'git.exe', purpose: 'git push' })
  assert.equal((await request({ pub: pub(1) })).error, 'bad_request', '同一把公鑰不能再開第二個請求')
  assert.equal((await request({ node: 'STRAY', pub: pub(2) })).error, 'not_owned', '沒綁帳號的設備沒有人能替它確認')
  assert.equal((await request({ node: 'NOPE', pub: pub(3) })).error, 'not_owned')
  for (const [k, v] of [['pub', 'short'], ['pub', 'P'.repeat(42) + '+'], ['program', ''], ['program', 'x'.repeat(81)], ['purpose', 'x'.repeat(201)], ['ttl', 29], ['ttl', 601], ['ttl', null]]) {
    assert.equal((await request({ pub: pub(10), [k]: v })).error, 'bad_request', `${k}=${v}`)
  }
  await request({ pub: pub(4) }); await request({ pub: pub(5) })
  assert.equal((await request({ pub: pub(6) })).error, 'too_many', '同時等待最多 3 筆')
  await db.exec(`update relay.secret_requests set status = 'denied'`)
  for (let i = 20; i < 37; i++) {
    assert.ok((await request({ pub: pub(i) })).id, `第 ${i} 筆`)
    await db.exec(`update relay.secret_requests set status = 'denied'`)
  }
  assert.equal((await request({ pub: pub(500) })).error, 'rate_limited', '每小時 20 筆')
})

test('實跑（pglite）：待確認——只有本人的設備看得到；只回公鑰與說明，不含密文；過期不顯示', { skip }, async () => {
  const { request, pending, reply, q, db } = await boot()
  const a = await request()
  const p = await pending()
  assert.equal(p.requests.length, 1)
  assert.deepEqual(Object.keys(p.requests[0]).sort(), ['created_at', 'expires_at', 'id', 'node', 'node_name', 'program', 'pub', 'purpose', 'seconds_left'])
  assert.deepEqual([p.requests[0].id, p.requests[0].node, p.requests[0].node_name, p.requests[0].pub], [a.id, 'CLOUD', '雲端代理', pub(1)])
  assert.equal((await pending('PC', null)).error, 'forbidden', '沒簽章')
  assert.equal((await pending('PC', U2)).error, 'forbidden', '簽章的人不擁有這台設備')
  assert.equal((await pending('OTHER', U2)).requests.length, 0, '別人看不到')
  await reply({ id: a.id })
  assert.equal((await pending()).requests.length, 0, '回覆過的不再出現')
  const b = await request({ pub: pub(2) })
  await db.exec(`update relay.secret_requests set expires_at = now() - interval '1 second' where id = '${b.id}'`)
  assert.equal((await pending()).requests.length, 0, '過期不顯示')
})

test('實跑（pglite）：回覆——非本人不能回、別人的請求回不了、一次性、過期不能回、拒絕不留密文', { skip }, async () => {
  const { request, reply, fetch, q, db } = await boot()
  const a = await request()
  assert.equal((await reply({ id: a.id, user: null })).error, 'forbidden', '沒簽章')
  assert.equal((await reply({ id: a.id, user: U2 })).error, 'forbidden', '簽章的人不擁有回覆的設備')
  assert.equal((await reply({ id: a.id, user: U2, actor: 'OTHER' })).error, 'not_found', '別人的設備簽章也回不了本人的請求')
  assert.equal((await q('select status from relay.secret_requests where id = $1', [a.id]))[0].status, 'pending', '被擋下的回覆沒有改任何東西')
  assert.equal((await reply({ id: a.id, cipher: 'short' })).error, 'bad_cipher')
  assert.equal((await reply({ id: a.id, cipher: 'bad!chars' + 'x'.repeat(200) })).error, 'bad_cipher')
  assert.equal((await reply({ id: NOID })).error, 'not_found')
  const ok = await reply({ id: a.id })
  assert.deepEqual([ok.ok, ok.bell_topic], [true, 'bell-CLOUD'], '回覆後敲請求端的門鈴')
  const row = (await q('select status, responder_node, cipher from relay.secret_requests where id = $1', [a.id]))[0]
  assert.deepEqual(row, { status: 'answered', responder_node: 'PC', cipher: CIPHER })
  assert.equal((await reply({ id: a.id })).error, 'already_answered', '一次性：不能回第二次')
  assert.equal((await reply({ id: a.id, deny: true })).error, 'already_answered', '回覆過也不能再拒絕')
  assert.equal((await q('select cipher from relay.secret_requests where id = $1', [a.id]))[0].cipher, CIPHER, '第二次回覆沒有覆蓋密文')
  const b = await request({ pub: pub(2) })
  await db.exec(`update relay.secret_requests set expires_at = now() - interval '1 second' where id = '${b.id}'`)
  assert.equal((await reply({ id: b.id })).error, 'expired', '過期不能回')
  const c = await request({ pub: pub(3) })
  assert.equal((await reply({ id: c.id, deny: true, cipher: CIPHER, actor: 'PHONE' })).ok, true)
  assert.deepEqual((await q('select status, cipher from relay.secret_requests where id = $1', [c.id]))[0], { status: 'denied', cipher: null }, '拒絕時就算帶了密文也不存')
  assert.deepEqual(await fetch('CLOUD', c.id), { status: 'denied' })
})

test('實跑（pglite）：取回——只有請求端、只能取一次、取走後密文清掉；過期取不到；別的節點取不到', { skip }, async () => {
  const { request, reply, fetch, q, db } = await boot()
  const a = await request()
  assert.deepEqual(await fetch('CLOUD', a.id), { status: 'pending' })
  assert.equal((await fetch('PC', a.id)).error, 'not_found', '別的節點（即使是本人的）不能取')
  assert.equal((await fetch('OTHER', a.id)).error, 'not_found')
  await reply({ id: a.id })
  assert.equal((await fetch('PC', a.id)).error, 'not_found', '回覆的設備也取不回密文')
  assert.deepEqual(await fetch('CLOUD', a.id), { status: 'answered', cipher: CIPHER })
  assert.deepEqual(await fetch('CLOUD', a.id), { status: 'delivered' }, '第二次取：沒有密文（一次性）')
  assert.equal((await q('select cipher from relay.secret_requests where id = $1', [a.id]))[0].cipher, null, '取走後資料庫裡的密文清成 null')
  assert.equal((await reply({ id: a.id })).error, 'already_answered')
  const b = await request({ pub: pub(2) })
  await reply({ id: b.id })
  await db.exec(`update relay.secret_requests set expires_at = now() - interval '1 second' where id = '${b.id}'`)
  assert.deepEqual(await fetch('CLOUD', b.id), { status: 'expired' }, '回覆了但沒在期限內取走：過期取不到')
  assert.equal((await q('select cipher from relay.secret_requests where id = $1', [b.id]))[0].cipher, null, '過期的密文被清掉')
  const c = await request({ pub: pub(3) })
  await db.exec(`update relay.secret_requests set expires_at = now() - interval '1 second' where id = '${c.id}'`)
  assert.deepEqual(await fetch('CLOUD', c.id), { status: 'expired' })
})

test('實跑（pglite）：過期自動清——過期一小時後整列刪除（公鑰也釋放）；密文在過期、取走、拒絕時就已清空', { skip }, async () => {
  const { request, reply, db, q, one } = await boot()
  const a = await request()
  await reply({ id: a.id })
  await db.exec(`update relay.secret_requests set expires_at = now() - interval '1 second'`)
  await one('select public.asn_relay_secret_purge()')
  const left = await q('select cipher, status from relay.secret_requests')
  assert.deepEqual(left, [{ cipher: null, status: 'answered' }], '剛過期：列還在（讓請求端查得到已過期）但密文沒了')
  await db.exec(`update relay.secret_requests set expires_at = now() - interval '61 minutes'`)
  await one('select public.asn_relay_secret_purge()')
  assert.equal((await q('select count(*)::int n from relay.secret_requests'))[0].n, 0)
  assert.ok((await request()).id, '列刪除後同一把公鑰才能再用（此時舊請求編號已不存在，舊密文無處可用）')
})
