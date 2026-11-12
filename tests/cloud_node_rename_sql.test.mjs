// 本人替雲端設備改名（20261106120000_cloud_node_rename.sql，#837）。
// 靜態檢查＋pglite 實跑（`npm i --no-save @electric-sql/pglite`，沒裝就略過實跑）。
// 實跑驗：只改自己名下的雲端節點；別人的、電腦、已撤銷、不存在一律 not_found；名字規則；群組顯示名只在等於舊名時跟著改；
//         bot 成員不動；同名不寫紀錄；有寫 account_events。
import { track, closeAtEnd } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const mig = fs.readFileSync(new URL('../supabase/migrations/20261106120000_cloud_node_rename.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const down = fs.readFileSync(new URL('../supabase/sql/rollback/20261106120000_cloud_node_rename_down.sql', import.meta.url), 'utf8')

test('靜態：security definer、search_path 空、只授權 service_role；有回復腳本', () => {
  assert.match(mig, /function public\.asn_cloud_node_rename\(p_user uuid, p_node text, p_name text\)[\s\S]*?security definer\s+set search_path to ''/)
  assert.match(mig, /revoke all on function public\.asn_cloud_node_rename\(uuid, text, text\) from public, anon, authenticated;/)
  assert.match(mig, /grant execute on function public\.asn_cloud_node_rename\(uuid, text, text\) to service_role;/)
  assert.doesNotMatch(mig, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.match(mig, /created_via = 'cloud-invite'/)
  assert.match(down, /drop function if exists public\.asn_cloud_node_rename\(uuid, text, text\);/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'

async function setup() {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, name text, owner_user uuid, status text default 'active', created_via text);
    create table relay.room_members(room_id text, member text, display_name text, primary key (room_id, member));
    create table relay.account_events(id bigint generated always as identity primary key, at timestamptz default now(),
      user_id uuid, event text not null, node text, detail jsonb);
    insert into relay.nodes values ('c1', 'Grok', '${U1}', 'active', 'cloud-invite'), ('c2', '別人的', '${U2}', 'active', 'cloud-invite'),
      ('pc', '工作機', '${U1}', 'active', 'login-device'), ('old', '撤銷的', '${U1}', 'left', 'cloud-invite');
    insert into relay.room_members values ('r1', 'c1', 'Grok'), ('r2', 'c1', '自訂'), ('r3', 'c1', null), ('r1', 'c1~Grok', 'Grok');`)
  await db.exec(mig)
  const call = async (u, n, name) => (await db.query('select public.asn_cloud_node_rename($1, $2, $3) as r', [u, n, name])).rows[0].r
  return { db, call }
}

test('實跑：只改自己名下的雲端節點，其餘 not_found', { skip: !PGlite }, async () => {
  const { db, call } = await setup()
  assert.equal((await call(U1, 'c2', 'x')).error, 'not_found', '別人的')
  assert.equal((await call(U1, 'pc', 'x')).error, 'not_found', '電腦')
  assert.equal((await call(U1, 'old', 'x')).error, 'not_found', '已撤銷')
  assert.equal((await call(U1, 'nope', 'x')).error, 'not_found', '不存在')
  assert.deepEqual((await db.query(`select id, name from relay.nodes order by id`)).rows.map(r => r.name), ['Grok', '別人的', '撤銷的', '工作機'])
  assert.equal((await db.query('select count(*)::int as n from relay.account_events')).rows[0].n, 0)
})

test('實跑：名字規則（去空白、1～40、無控制字元）', { skip: !PGlite }, async () => {
  const { call } = await setup()
  for (const bad of [null, '', '   ', 'a'.repeat(41), 'a\nb']) assert.equal((await call(U1, 'c1', bad)).error, 'bad_request', JSON.stringify(bad))
  assert.equal((await call(null, 'c1', 'x')).error, 'bad_request')
  assert.deepEqual(await call(U1, 'c1', '  雲端 Grok  '), { ok: true, name: '雲端 Grok', changed: true })
})

test('實跑：群組顯示名等於舊名才跟著改；空的與自訂的不動；bot 成員不動；寫紀錄', { skip: !PGlite }, async () => {
  const { db, call } = await setup()
  await call(U1, 'c1', '雲端')
  const m = Object.fromEntries((await db.query(`select room_id || '/' || member as k, display_name from relay.room_members`)).rows.map(r => [r.k, r.display_name]))
  assert.deepEqual(m, { 'r1/c1': '雲端', 'r2/c1': '自訂', 'r3/c1': null, 'r1/c1~Grok': 'Grok' })
  const ev = (await db.query('select user_id, event, node, detail from relay.account_events')).rows
  assert.deepEqual(ev, [{ user_id: U1, event: 'cloud_node_renamed', node: 'c1', detail: { from: 'Grok', to: '雲端', rooms: 1 } }])
  assert.deepEqual(await call(U1, 'c1', '雲端'), { ok: true, name: '雲端', changed: false }, '同名不改')
  assert.equal((await db.query('select count(*)::int as n from relay.account_events')).rows[0].n, 1, '同名不寫紀錄')
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
