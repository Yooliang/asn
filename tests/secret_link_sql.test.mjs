// 遠端密碼傳遞的登入網址（20261101230000_secret_link.sql；#628 第 3 段）：
// 1. 靜態：新函式 security definer＋search_path 空、只授權 service_role；欄位有檢查約束；簽章與網域檢查在函式裡。
// 2. 實跑（pglite，沒裝就略過）：帶網址的請求一定要本人簽章且擁有請求端節點；網址只收官方登入網域的 https；
//    待確認清單回 link（沒有就 null）；舊的五參數請求函式照常運作；欄位的檢查約束擋得住直接寫入。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const base = read('20261023060000_secret_remote.sql')
const sql = read('20261101230000_secret_link.sql')

test('靜態：新函式 security definer、search_path 空、只授權 service_role；取代的待確認函式介面不變', () => {
  for (const sig of ['asn_relay_secret_request_link\\(text, text, text, text, integer, text, uuid\\)', 'asn_relay_secret_pending\\(text, uuid\\)']) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${sig} from public, anon, authenticated;`), sig)
    assert.match(sql, new RegExp(`grant execute on function public\\.${sig} to service_role;`), sig)
  }
  assert.equal((sql.match(/security definer\nset search_path to ''/g) ?? []).length, 2)
  assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(sql, /create policy/)
  assert.doesNotMatch(sql, /irori_relay_/)
})

test('靜態：帶網址的請求要本人簽章並擁有請求端節點；網域檢查在函式與欄位約束各一次，同一條規則', () => {
  const fn = sql.slice(sql.indexOf('function public.asn_relay_secret_request_link('), sql.indexOf('function public.asn_relay_secret_pending('))
  assert.match(fn, /p_signed_user is null or not public\.asn_user_owns_node\(p_signed_user, p_node\)/)
  assert.match(fn, /return jsonb_build_object\('error', 'forbidden'\)/)
  assert.match(fn, /public\.asn_relay_secret_request\(p_node, p_pub, p_program, p_purpose, p_ttl_seconds\)/)
  const rule = String.raw`^https://([a-z0-9-]+\.)*(claude\.ai|claude\.com|anthropic\.com)(:443)?([/?#][\x21-\x5b\x5d-\x7e]*)?$`
  assert.equal(sql.split(rule).length - 1, 2, '約束與函式用同一條規則')
  assert.match(sql, /add column if not exists link text/)
  // 沒有改到既有的資料表定義與其他函式
  assert.doesNotMatch(sql, /create table/)
  assert.doesNotMatch(sql, /function public\.asn_relay_secret_(reply|fetch|purge)\(/)
  assert.ok(base.includes('asn_relay_secret_request('))
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const T2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const pub = n => String(n).padStart(43, 'P')
const LINK = 'https://claude.ai/oauth/authorize?client_id=C&state=S&code_challenge=H&redirect_uri=R'

async function boot() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', owner_user uuid, name text, bell_topic text);
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable as
      $$ select p_user is not null and exists (select 1 from relay.nodes n where n.id = p_node and n.status = 'active' and n.owner_user = p_user) $$;
    insert into relay.nodes(id, tenant_id, owner_user, name, bell_topic) values
      ('NEWPC','${T1}','${U1}','新電腦','bell-NEWPC'),
      ('PHONE','${T1}','${U1}','手機','bell-PHONE'),
      ('OTHER','${T2}','${U2}','別人的電腦','bell-OTHER'),
      ('STRAY','${T1}',null,'沒綁帳號','bell-STRAY');`)
  await db.exec(base)
  await db.exec(sql)
  const one = async (text, args) => (await db.query(text, args)).rows[0]
  const reqLink = async (o = {}) => (await one('select public.asn_relay_secret_request_link($1,$2,$3,$4,$5,$6,$7) r',
    [o.node ?? 'NEWPC', o.pub ?? pub(1), o.program ?? 'Claude Code 登入', o.purpose ?? '在新電腦登入', 'ttl' in o ? o.ttl : 180, 'link' in o ? o.link : LINK, 'user' in o ? o.user : U1])).r
  const reqPlain = async (o = {}) => (await one('select public.asn_relay_secret_request($1,$2,$3,$4,$5) r',
    [o.node ?? 'NEWPC', o.pub ?? pub(50), 'git.exe', 'git push', 180])).r
  const pending = async (actor = 'PHONE', user = U1) => (await one('select public.asn_relay_secret_pending($1,$2) r', [actor, user])).r
  return { db, reqLink, reqPlain, pending, q: async (t, a) => (await db.query(t, a)).rows }
}

test('實跑（pglite）：帶網址的請求——本人簽章且擁有請求端節點才行；網址存起來，待確認清單回得出來', { skip }, async () => {
  const { reqLink, pending, q } = await boot()
  const ok = await reqLink()
  assert.ok(ok.id)
  assert.deepEqual(ok.bell_topics, ['bell-PHONE'], '門鈴只敲本人其他設備')
  assert.equal((await q('select link from relay.secret_requests where id = $1', [ok.id]))[0].link, LINK)
  const p = (await pending()).requests
  assert.equal(p.length, 1)
  assert.equal(p[0].link, LINK)
  assert.equal(p[0].node_name, '新電腦')
  assert.equal((await pending('PHONE', U2)).error, 'forbidden', '別人的簽章看不到')
})

test('實跑（pglite）：沒簽章、別人的簽章、沒綁帳號的節點——都 forbidden，不留下任何一列', { skip }, async () => {
  const { reqLink, q } = await boot()
  assert.equal((await reqLink({ user: null })).error, 'forbidden', '沒簽章（AI 只有節點金鑰）')
  assert.equal((await reqLink({ user: U2, pub: pub(2) })).error, 'forbidden', '別人的簽章')
  assert.equal((await reqLink({ node: 'STRAY', pub: pub(3) })).error, 'forbidden', '沒綁帳號的節點')
  assert.equal((await reqLink({ node: 'OTHER', pub: pub(4) })).error, 'forbidden', '簽章的人不擁有請求端節點')
  assert.equal((await q('select count(*)::int n from relay.secret_requests'))[0].n, 0)
})

test('實跑（pglite）：網址只收官方登入網域的 https；其他寫法 bad_request，不留下任何一列', { skip }, async () => {
  const { reqLink, q } = await boot()
  let i = 10
  for (const bad of [
    null, '', 'http://claude.ai/x', 'https://claude.ai.evil.com/x', 'https://evilclaude.ai/x', 'https://claude.ai@evil.com/x', 'https://evil.com/claude.ai',
    'https://claude.ai:8443/x', 'https://claude.ai/x y', 'https://claude.ai/x\ty', 'https://claude.ai/x\\y', 'https://CLAUDE.AI/x', 'https://claude。ai/x',
    'https://claude.ai./x', 'javascript:alert(1)', 'https://', 'https://claude.ai/' + 'a'.repeat(2100), 'https://claude.ai/é',
  ]) {
    assert.equal((await reqLink({ link: bad, pub: pub(i++) })).error, 'bad_request', JSON.stringify(bad).slice(0, 50))
  }
  assert.equal((await q('select count(*)::int n from relay.secret_requests'))[0].n, 0)
  for (const good of ['https://claude.ai', 'https://www.claude.ai/a', 'https://platform.claude.com/x?y=1#z', 'https://console.anthropic.com/oauth', 'https://claude.ai:443/x']) {
    assert.ok((await reqLink({ link: good, pub: pub(i++) })).id, good)
    await q(`update relay.secret_requests set status = 'denied'`)
  }
})

test('實跑（pglite）：共用正反例（與 Edge Function、Rust、手機畫面讀同一份）', { skip }, async () => {
  const { reqLink, q } = await boot()
  const cases = JSON.parse(fs.readFileSync(new URL('../supabase/functions/_shared/login_link_cases.json', import.meta.url), 'utf8'))
  const expand = s => s.replace('<A*2100>', 'a'.repeat(2100))
  assert.ok(cases.good.length >= 5 && cases.bad.length >= 20, '測資不能被清空')
  let i = 200
  // 空字元連資料庫的參數都送不進去（編碼錯誤），不在這裡比；其餘照比
  for (const b of cases.bad.filter(x => !x.includes('\0'))) assert.equal((await reqLink({ link: expand(b), pub: pub(i++) })).error, 'bad_request', b.slice(0, 40))
  assert.equal((await q('select count(*)::int n from relay.secret_requests'))[0].n, 0)
  for (const g of cases.good) {
    assert.ok((await reqLink({ link: expand(g), pub: pub(i++) })).id, g)
    await q(`update relay.secret_requests set status = 'denied'`)
  }
})

test('實跑（pglite）：欄位的檢查約束擋得住直接寫入；舊的五參數請求照常運作且沒有網址', { skip }, async () => {
  const { reqLink, reqPlain, pending, db } = await boot()
  const a = await reqLink()
  await assert.rejects(db.exec(`update relay.secret_requests set link = 'https://evil.example/x' where id = '${a.id}'`), /secret_requests_link_ck/)
  await assert.rejects(db.exec(`update relay.secret_requests set link = 'http://claude.ai/x' where id = '${a.id}'`), /secret_requests_link_ck/)
  for (const tail of ['x y', 'x	y', 'x\\y', 'é']) {
    await assert.rejects(db.exec(`update relay.secret_requests set link = 'https://claude.ai/${tail}' where id = '${a.id}'`), /secret_requests_link_ck/, tail)
  }
  const plain = await reqPlain()
  assert.ok(plain.id)
  const list = (await pending()).requests
  assert.equal(list.find(r => r.id === plain.id).link, null, '沒帶網址的請求 link 是 null')
  assert.equal(list.find(r => r.id === a.id).link, LINK)
})

test('實跑（pglite）：帶網址的請求仍受公鑰唯一、同時上限、有效期限的規則限制', { skip }, async () => {
  const { reqLink } = await boot()
  assert.ok((await reqLink({ pub: pub(1) })).id)
  assert.equal((await reqLink({ pub: pub(1) })).error, 'bad_request', '同一把公鑰不能再開第二個請求')
  assert.equal((await reqLink({ pub: pub(2), ttl: 29 })).error, 'bad_request')
  assert.ok((await reqLink({ pub: pub(3) })).id)
  assert.ok((await reqLink({ pub: pub(4) })).id)
  assert.equal((await reqLink({ pub: pub(5) })).error, 'too_many', '同時等待最多 3 筆')
})
