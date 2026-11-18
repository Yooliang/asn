// 附件額度依寄件人分開算（20261119000000_attach_quota_per_sender.sql，#1723）：
// asn_relay_attach_init 多三個選填參數（p_signed_user、p_ai_quota_bytes、p_ai_quota_count），每筆附件記 sender_kind（owner／agent）。
// 涵蓋：本人（憑證有效且擁有這台設備）記 owner，其餘記 agent；AI 桶滿只擋 AI、本人照過；設備總量滿兩邊都擋；
// 舊資料（sender_kind 空）只算設備總量；不帶新參數＝與舊版相同；過期與已清掉的不算；函式只有一個版本（沒有多載）；回復檔能還原舊版。
// 沒裝 @electric-sql/pglite 時只跑靜態部分。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = s => s.replace(/\r+\n/g, '\n')
const DIR = new URL('../supabase/migrations/', import.meta.url)
const FILE = '20261119000000_attach_quota_per_sender.sql'
const mig = rd(fs.readFileSync(new URL(FILE, DIR), 'utf8'))
const down = rd(fs.readFileSync(new URL('../supabase/sql/rollback/20261119000000_attach_quota_per_sender_down.sql', import.meta.url), 'utf8'))
const NEW_SIG = 'asn_relay_attach_init(text, text, text, text, integer, integer, integer, text, text, bigint, integer, uuid, bigint, integer)'
const OLD_SIG = 'asn_relay_attach_init(text, text, text, text, integer, integer, integer, text, text, bigint, integer)'

test('靜態：只授權 service_role、search_path 空；先 drop 舊簽章；有回復檔；排在最新的 migration 之後', () => {
  const body = mig.replace(/^--.*$/gm, '')
  assert.ok(body.includes(`revoke all on function public.${NEW_SIG} from public, anon, authenticated;`))
  assert.ok(body.includes(`grant execute on function public.${NEW_SIG} to service_role;`))
  assert.match(body, /security definer\s+set search_path to ''/)
  assert.ok(body.indexOf(`drop function if exists public.${OLD_SIG}`) >= 0)
  assert.ok(body.indexOf('drop function if exists') < body.indexOf('create or replace function public.asn_relay_attach_init'))
  assert.match(body, /asn_user_owns_node\(p_signed_user, p_node\)/)
  assert.ok(down.includes(`drop function if exists public.${NEW_SIG}`))
  assert.ok(down.includes(`grant execute on function public.${OLD_SIG} to service_role;`))
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(FILE) > files.indexOf('20261118200000_term_view_busy.sql'))
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟，整支失敗、不會無聲略過
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
closeAtEnd()

const OWNER = '00000000-0000-0000-0000-0000000000a1' // 擁有 H 的人
const OTHER = '00000000-0000-0000-0000-0000000000a2' // 憑證有效但不擁有 H
const T = '00000000-0000-0000-0000-0000000000f1'

// 舊表與舊函式（回復檔裡就是目前線上的 11 參數定義）→ 再套新 migration，等於實際升級的路徑
async function boot({ upgrade = true } = {}) {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes (id text primary key, tenant_id uuid not null, status text not null default 'active');
    create table relay.attachments (
      id uuid primary key default gen_random_uuid(), tenant_id uuid not null, owner_node text not null, kind text not null, mime text not null,
      name text not null, bytes integer not null, width integer, height integer, thumb text, sha256 text, storage_path text not null,
      status text not null default 'pending', created_at timestamptz not null default now(),
      expires_at timestamptz not null default (now() + interval '30 days'), removed_at timestamptz);
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql as $$
      select p_user = '${OWNER}'::uuid and p_node = 'H' $$;
    insert into relay.nodes values ('H', '${T}', 'active'), ('Z', '${T}', 'inactive');`)
  await db.exec(down) // 目前線上的函式
  if (upgrade) await db.exec(mig)
  const q = async (t, a) => (await db.query(t, a)).rows
  // 舊資料：直接塞進表（時間在一小時前，不吃每分鐘 30 次的限流）
  const legacy = (n, bytes = 100, extra = '') => db.exec(
    `insert into relay.attachments (tenant_id, owner_node, kind, mime, name, bytes, storage_path, status, created_at ${extra ? ', ' + extra.split('=')[0] : ''})
     select '${T}', 'H', 'image', 'image/webp', 'a.webp', ${bytes}, 'p', 'ready', now() - interval '1 hour' ${extra ? ', ' + extra.split('=')[1] : ''} from generate_series(1, ${n})`)
  // 新版呼叫：具名參數；tail 是尾端選填參數
  const init = async (o = {}) => {
    const { node = 'H', bytes = 100, qb = 1000, qc = 10, user, aiB, aiC } = o
    const extra = [user && `p_signed_user => '${user}'::uuid`, aiB != null && `p_ai_quota_bytes => ${aiB}`, aiC != null && `p_ai_quota_count => ${aiC}`].filter(Boolean)
    const r = await q(`select public.asn_relay_attach_init(p_node => $1, p_kind => 'image', p_mime => 'image/webp', p_name => 'a.webp', p_bytes => $2,
      p_width => null, p_height => null, p_thumb => null, p_sha256 => null, p_quota_bytes => $3, p_quota_count => $4${extra.length ? ', ' + extra.join(', ') : ''}) r`, [node, bytes, qb, qc])
    return r[0].r
  }
  const kinds = async () => (await q(`select sender_kind k, count(*)::int n from relay.attachments where created_at > now() - interval '5 minutes' group by 1 order by 1`)).map(r => [r.k, r.n])
  return { db, q, init, legacy, kinds }
}

test('實跑：本人憑證有效且擁有這台設備記 owner；沒帶、不擁有這台設備的憑證都記 agent', { skip }, async () => {
  const { init, kinds } = await boot()
  assert.ok((await init({ user: OWNER })).id)
  assert.ok((await init()).id)
  assert.ok((await init({ user: OTHER })).id)
  assert.deepEqual(await kinds(), [['agent', 2], ['owner', 1]])
})

test('實跑：AI 桶滿了只擋 AI（scope=agent），本人照過；設備總量滿兩邊都擋（scope=device）', { skip }, async () => {
  const { init } = await boot()
  for (let i = 0; i < 3; i++) assert.ok((await init({ aiC: 3 })).id)
  const full = await init({ aiC: 3 })
  assert.deepEqual([full.error, full.scope, full.used_count], ['quota_exceeded', 'agent', 3])
  assert.ok((await init({ user: OWNER, aiC: 3 })).id, 'AI 桶滿了本人仍可傳')
  assert.ok((await init({ user: OWNER, aiC: 3 })).id)
  // 設備總量（qc=10）：再補到 10 筆，之後本人也被擋
  for (let i = 0; i < 5; i++) await init({ user: OWNER, aiC: 3 })
  const dev = await init({ user: OWNER, aiC: 3 })
  assert.deepEqual([dev.error, dev.scope], ['quota_exceeded', 'device'])
  assert.equal((await init({ aiC: 3 })).scope, 'device', '設備總量先檢查')
})

test('實跑：AI 上限也看容量（位元組）；本人不受 AI 容量上限限制', { skip }, async () => {
  const { init } = await boot()
  assert.ok((await init({ bytes: 400, aiB: 500 })).id)
  const full = await init({ bytes: 200, aiB: 500 })
  assert.deepEqual([full.error, full.scope, full.used_bytes], ['quota_exceeded', 'agent', 400])
  assert.ok((await init({ bytes: 200, aiB: 500, user: OWNER })).id)
})

test('實跑：舊資料（sender_kind 空）只算設備總量、不算 AI 桶', { skip }, async () => {
  const { init, legacy, q } = await boot()
  await legacy(8) // 8 筆舊資料；設備總量 10
  assert.ok((await init({ aiC: 3 })).id, '舊資料不佔 AI 桶')
  assert.ok((await init({ aiC: 3 })).id)
  const dev = await init({ aiC: 3 })
  assert.equal(dev.scope, 'device', '合計 10 筆：設備總量先滿')
  assert.equal((await q(`select count(*)::int n from relay.attachments where sender_kind is null`))[0].n, 8)
})

test('實跑：不帶新參數（舊 Edge 的 11 個參數）照常運作、行為與舊版相同，AI 上限不啟用', { skip }, async () => {
  const { init, q } = await boot()
  for (let i = 0; i < 5; i++) assert.ok((await init()).id) // 沒設 AI 上限：不限 AI 桶
  const rows = await q(`select sender_kind k from relay.attachments`)
  assert.equal(rows.length, 5)
  const old = await q(`select public.asn_relay_attach_init('H','image','image/webp','a.webp',100,null,null,null,null,1000::bigint,10) r`)
  assert.ok(old[0].r.id, '全位置參數的舊呼叫（含舊名包裝的呼叫方式）也能呼叫')
  assert.equal((await init({ node: 'Z' })).error, 'forbidden', '停用節點照舊 forbidden')
})

test('實跑：過期與已清掉的不算進兩個桶', { skip }, async () => {
  const { init, db } = await boot()
  for (let i = 0; i < 3; i++) await init({ aiC: 3 })
  assert.equal((await init({ aiC: 3 })).scope, 'agent')
  await db.exec(`update relay.attachments set removed_at = now() where id in (select id from relay.attachments order by id limit 1);
                 update relay.attachments set expires_at = now() - interval '1 minute' where id in (select id from relay.attachments where removed_at is null order by id limit 1)`)
  assert.ok((await init({ aiC: 3 })).id, '清掉一筆、過期一筆後 AI 桶有空位')
})

test('實跑：函式只有一個版本（沒有多載，具名呼叫不會無法選擇）；回復檔還原成舊版 11 參數且能用', { skip }, async () => {
  const { db, q, init } = await boot()
  const count = async () => (await q(`select count(*)::int n from pg_proc where proname = 'asn_relay_attach_init' and pronamespace = 'public'::regnamespace`))[0].n
  assert.equal(await count(), 1)
  assert.equal((await q(`select pronargs::int n from pg_proc where proname = 'asn_relay_attach_init'`))[0].n, 14)
  await db.exec(down)
  assert.equal(await count(), 1)
  assert.equal((await q(`select pronargs::int n from pg_proc where proname = 'asn_relay_attach_init'`))[0].n, 11)
  const r = (await q(`select public.asn_relay_attach_init('H','image','image/webp','a.webp',100,null,null,null,null,1000::bigint,10) r`))[0].r
  assert.ok(r.id)
  assert.ok(init) // 回復後新版呼叫不再可用（找不到函式），由 Edge 去掉新參數重試
  await assert.rejects(() => init({ user: OWNER }), /function .* does not exist|asn_relay_attach_init/)
})

test('實跑：套用兩次不壞（可重跑）', { skip }, async () => {
  const { db, init } = await boot()
  await db.exec(mig)
  assert.ok((await init({ user: OWNER })).id)
})
