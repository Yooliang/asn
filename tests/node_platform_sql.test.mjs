// 0.2 H2 migration（20261028120000_node_platform.sql）：設備回報平台與「不開放開新夥伴」的原因。
// 1. 靜態：只加欄位與函式（不改舊值）、新函式只授權 service_role。
// 2. 實跑：有安裝 @electric-sql/pglite 時（不是專案相依，自己 `npm i --no-save @electric-sql/pglite`）套用 migration：
//    平台不在清單就存 null、原因過濾成純文字並限 120 字、只改自己節點、launchers 回新欄位並列出有回報平台的沒開放設備。沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = fs.readFileSync(new URL('../supabase/migrations/20261028120000_node_platform.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('靜態：只加可為 null 的欄位與檢查條件；新函式 security definer、search_path 空、只授權 service_role', () => {
  assert.match(sql, /add column if not exists platform text;/)
  assert.match(sql, /add column if not exists launch_closed_reason text;/)
  assert.match(sql, /platform in \('linux', 'windows', 'macos'\)/)
  assert.doesNotMatch(sql, /drop column|alter column|update relay\.nodes set [^;]*where (?!id = p_node)/)
  assert.match(sql, /revoke all on function public\.asn_relay_set_platform\(text, text, text\) from public, anon, authenticated;/)
  assert.match(sql, /grant execute on function public\.asn_relay_set_platform\(text, text, text\) to service_role;/)
  assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.equal((sql.match(/security definer\s*\n\s*set search_path to ''/gi) ?? []).length, 2)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const U1 = '11111111-1111-1111-1111-111111111111'
const T1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

test('實跑（pglite）：平台只收固定值、原因過濾成純文字、只改自己節點；launchers 回新欄位並列出沒開放但有回報平台的設備', { skip }, async () => {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', role text default 'member', owner_user uuid, name text, machine boolean default true,
      launcher jsonb, launcher_at timestamptz, last_seen_at timestamptz default now());
    create table relay.launches(id uuid primary key, tenant_id uuid, node text, profile text, name text, cwd text, status text, detail text, created_at timestamptz default now(), done_at timestamptz);
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable as
      $$ select p_user is not null and exists (select 1 from relay.nodes n where n.id = p_node and n.status = 'active' and n.owner_user = p_user) $$;
    insert into relay.nodes(id, tenant_id, owner_user, name, launcher) values
      ('P','${T1}','${U1}','手機', null), ('W','${T1}','${U1}','桌機', '{"profiles":[]}'), ('L','${T1}','${U1}','測試用 Linux', null), ('Q','${T1}','${U1}','另一台 Linux', null);`)
  await db.exec(sql)
  const set = async (node, p, r) => (await db.query('select public.asn_relay_set_platform($1,$2,$3) r', [node, p, r])).rows[0].r
  const row = async id => (await db.query('select platform, launch_closed_reason from relay.nodes where id = $1', [id])).rows[0]
  assert.deepEqual(await set('L', 'linux', null), { ok: true })
  assert.deepEqual(await row('L'), { platform: 'linux', launch_closed_reason: null })
  await set('Q', 'Linux; drop table x', `  公司的伺服器\n不開放${'字'.repeat(200)}  `)
  const q = await row('Q')
  assert.equal(q.platform, null, '不在清單裡就存 null')
  assert.ok(q.launch_closed_reason.startsWith('公司的伺服器 不開放'), q.launch_closed_reason)
  assert.equal([...q.launch_closed_reason].length, 120)
  await set('Q', 'linux', '   ')
  assert.deepEqual(await row('Q'), { platform: 'linux', launch_closed_reason: null }, '空白原因存 null')
  assert.deepEqual(await set('不存在', 'linux', null), { error: 'forbidden' })
  await assert.rejects(db.query("update relay.nodes set platform = 'beos' where id = 'P'"), /nodes_platform_check/, '資料表也擋任意字串')
  const r = (await db.query('select public.asn_relay_launchers($1,$2,$3) r', ['P', null, U1])).rows[0].r
  assert.deepEqual(r.machines.map(m => [m.node, m.platform, m.launcher === null]), [['L', 'linux', true], ['Q', 'linux', true], ['W', null, false]], '沒開放的 Linux 也列出來（launcher 還是 null＝沒開放）；手機不列')
  assert.ok(r.machines.every(m => 'launch_closed_reason' in m))
})
