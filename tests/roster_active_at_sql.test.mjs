// 0.2 E2／E4（#397）migration 20261028200000_roster_active_at.sql：名單回報帶 active_at，寫進夥伴的最後活動時間。
// 1. 靜態：只動 asn_relay_roster；與正式庫現行定義比只多那一段 update（含一行註解），其餘一個字不動；不刪不改資料表、不改授權。
// 2. 實跑（pglite；沒裝略過）：有帶就寫、未來時間當現在、30 天前不寫、10 秒內不重複、只往後不往前、別台同名與舊名字不寫、
//    壞值不拒絕整份名單、舊版沒帶的照舊。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mig = read('../supabase/migrations/20261028200000_roster_active_at.sql')
const base = read('./fixtures/asn_relay_roster.prod-20261028.sql')
const fnOf = sql => sql.slice(sql.search(/create or replace function public\.asn_relay_roster/i), sql.lastIndexOf('$function$') + '$function$'.length)

test('靜態：只多一段 update relay.partners，其餘與正式庫現行定義逐字相同；沒有刪改資料表、沒有新授權', () => {
  const code = mig.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|alter table|alter column|delete from relay\.partners|truncate|drop function|grant /i)
  assert.match(code, /^begin;$/m)
  assert.match(code, /^commit;$/m)
  const now = fnOf(mig).split('\n')
  const was = base.trim().split('\n')
  const added = now.filter(l => !was.includes(l))
  assert.equal(added.length, 8, added.join('\n'))
  assert.match(added[0], /^\s*-- 0\.2 E2/)
  assert.match(added[1], /update relay\.partners p set last_active_at = t\.at/)
  assert.equal(now.filter(l => !added.includes(l)).join('\n'), base.trim())
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const T1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const P1 = 'p_00000000000000000001'
const P2 = 'p_00000000000000000002'
const P3 = 'p_00000000000000000003'

async function boot() {
  const db = new PGlite()
  await db.exec(`create role service_role; create schema relay;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', can_invite boolean default false, can_roster boolean default true,
      roster_bell_at timestamptz, bell_topic text, last_seen_at timestamptz default now());
    create table relay.partners(partner_id text primary key, node text references relay.nodes(id), current_name text, last_active_at timestamptz);
    create table relay.roster(node text, name text, status text, cwd_label text, engine text, detail text, context_pct smallint, mod_loaded boolean, kind text, receivable boolean,
      model text, hidden boolean, seen_at timestamptz default now(), primary key (node, name));
    insert into relay.nodes(id, tenant_id) values ('H', '${T1}'), ('W', '${T1}');
    insert into relay.partners(partner_id, node, current_name) values ('${P1}', 'H', '小文'), ('${P2}', 'H', null), ('${P3}', 'W', '小文');`)
  await db.exec(mig)
  return db
}
const roster = async (db, node, agents) => (await db.query('select public.asn_relay_roster($1, $2::jsonb) r', [node, JSON.stringify(agents)])).rows[0].r
const lastOf = async (db, id) => (await db.query('select last_active_at t from relay.partners where partner_id = $1', [id])).rows[0].t
const ms = d => d.getTime()

test('實跑：帶 active_at 就寫進夥伴；舊版沒帶、別台同名、名字被讓出的夥伴都不寫；名單照常換掉', { skip }, async () => {
  const db = await boot()
  const t = Date.now() - 60_000
  assert.deepEqual((await roster(db, 'H', [{ name: '小文', status: 'busy' }])).count, 1)
  assert.equal(await lastOf(db, P1), null, '舊版沒帶：不寫')
  const r = await roster(db, 'H', [{ name: '小文', status: 'busy', active_at: t }, { name: '沒夥伴', active_at: t }])
  assert.equal(r.count, 2, '名單照常')
  assert.equal(ms(await lastOf(db, P1)), t)
  assert.equal(await lastOf(db, P2), null, '名字被讓出的夥伴不寫')
  assert.equal(await lastOf(db, P3), null, '別台同名不寫')
})

test('實跑：未來時間當現在、30 天前不寫、10 秒內不重複、只往後不往前；壞值不拒絕名單', { skip }, async () => {
  const db = await boot()
  await roster(db, 'H', [{ name: '小文', active_at: Date.now() - 31 * 86_400_000 }])
  assert.equal(await lastOf(db, P1), null, '30 天前不寫')
  await roster(db, 'H', [{ name: '小文', active_at: Date.now() + 3_600_000 }])
  const capped = ms(await lastOf(db, P1))
  assert.ok(Math.abs(capped - Date.now()) < 5_000, '未來時間當現在')
  await roster(db, 'H', [{ name: '小文', active_at: Date.now() - 600_000 }])
  assert.equal(ms(await lastOf(db, P1)), capped, '不往前')
  await db.exec("update relay.partners set last_active_at = now() - interval '20 seconds'")
  const before = ms(await lastOf(db, P1))
  await roster(db, 'H', [{ name: '小文', active_at: before + 5_000 }])
  assert.equal(ms(await lastOf(db, P1)), before, '10 秒內不重複寫')
  await roster(db, 'H', [{ name: '小文', active_at: before + 11_000 }])
  assert.equal(ms(await lastOf(db, P1)), before + 11_000)
  for (const bad of ['123', -1, 0, 1e300, true, null]) {
    const r = await roster(db, 'H', [{ name: '小文', active_at: bad }])
    assert.equal(r.count, 1, `壞值 ${bad} 不拒絕名單`)
  }
  assert.equal(ms(await lastOf(db, P1)), before + 11_000, '壞值不寫')
  // 同名重複出現：取最新的
  await db.exec("update relay.partners set last_active_at = null")
  await roster(db, 'H', [{ name: '小文', active_at: Date.now() - 50_000 }, { name: '小文', active_at: Date.now() - 20_000 }])
  assert.ok(Date.now() - ms(await lastOf(db, P1)) < 25_000, '同名取最新')
})
