// 夥伴 ID migration（#109）：
// 1. 靜態檢查：RLS、只給 service_role、security definer＋search_path ''、清理排程冪等。
// 2. 實跑檢查：有安裝 @electric-sql/pglite 時（不是專案相依，要測的人自己 `npm i --no-save @electric-sql/pglite`），
//    在記憶體內的 Postgres 套用 migration（拿掉 pg_cron 那段），逐條跑規則 1～4、冪等、寄信解析；沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const sql = read('20261022000100_partner_id.sql')

test('三張表：RLS 開、不給 anon／authenticated、沒有 policy；信上有可空的夥伴欄位', () => {
  for (const t of ['partners', 'partner_names', 'partner_sessions']) {
    assert.match(sql, new RegExp(`create table relay\\.${t} \\(`))
    assert.match(sql, new RegExp(`alter table relay\\.${t} enable row level security;`))
    assert.match(sql, new RegExp(`revoke all on relay\\.${t} from public, anon, authenticated;`))
  }
  assert.doesNotMatch(sql, /create policy/)
  assert.match(sql, /partner_id ~ '\^p_\[0-9a-f\]\{20\}\$'/)
  assert.match(sql, /unique index partners_node_name_uidx on relay\.partners \(node, current_name\) where current_name is not null/)
  assert.match(sql, /add column if not exists to_partner_id text;/)
  assert.match(sql, /add column if not exists from_partner_id text;/)
  assert.doesNotMatch(sql, /to_partner_id text not null/)
})

test('函式：security definer、search_path 空、只授權 service_role', () => {
  assert.match(sql, /function public\.irori_relay_partner_sync\(p_node text, p_windows jsonb\)[\s\S]*?security definer[\s\S]*?set search_path to ''/)
  assert.match(sql, /revoke all on function public\.irori_relay_partner_sync\(text, jsonb\) from public, anon, authenticated;/)
  assert.match(sql, /grant execute on function public\.irori_relay_partner_sync\(text, jsonb\) to service_role;/)
  assert.match(sql, /function relay\.partner_resolve\(p_node text, p_name text\)[\s\S]*?security definer[\s\S]*?set search_path to ''/)
  assert.match(sql, /function relay\.messages_resolve_partner\(\)[\s\S]*?security definer[\s\S]*?set search_path to ''/)
  assert.match(sql, /revoke all on function relay\.messages_resolve_partner\(\) from public, anon, authenticated;/)
  assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated|public)/)
})

test('同步只動自己節點、節點要存在且啟用；寄信函式沒被重寫（不改變誰收到信）', () => {
  assert.match(sql, /where id = p_node and status = 'active'/)
  assert.doesNotMatch(sql, /function public\.irori_relay_send/)
  assert.doesNotMatch(sql, /function public\.irori_relay_inbox/)
  assert.match(sql, /create trigger messages_resolve_partner before insert on relay\.messages/)
  assert.match(sql, /exception when others then\s+null;/)
})

test('清理排程：冪等（先 unschedule）；舊名 90 天、夥伴 180 天', () => {
  assert.match(sql, /cron\.unschedule\('asn-partners-purge'\)/)
  assert.match(sql, /cron\.schedule\('asn-partners-purge', '31 3 \* \* \*'/)
  assert.match(sql, /delete from relay\.partner_names where renamed_at < now\(\) - interval '90 days'/)
  assert.match(sql, /delete from relay\.partners where updated_at < now\(\) - interval '180 days'/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }

test('實跑（pglite）：規則 1～4、冪等、舊名轉寄期、寄信解析', { skip: PGlite ? false : '沒有安裝 @electric-sql/pglite' }, async () => {
  const mig = sql.replace(/create extension if not exists pg_cron;[\s\S]*?\$\$\);\n/, '')
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active');
    create table relay.messages(id uuid primary key default gen_random_uuid(), from_node text, from_agent text, to_node text, to_agent text, body text);
    insert into relay.nodes values ('N1', gen_random_uuid(), 'active'), ('N2', gen_random_uuid(), 'active');`)
  await db.exec(mig)
  const sync = async (node, ws) => (await db.query('select public.irori_relay_partner_sync($1,$2::jsonb) r', [node, JSON.stringify(ws)])).rows[0].r
  const q = async (text, args) => (await db.query(text, args)).rows
  const ids = r => Object.fromEntries(r.partners.map(p => [p.name, p.partner_id]))
  const S1 = 'sess-0001-aaaa', S2 = 'sess-0002-bbbb', S3 = 'sess-0003-cccc'

  const A = ids(await sync('N1', [{ name: '甲', session_id: S1, engine: 'claude' }]))['甲']
  assert.match(A, /^p_[0-9a-f]{20}$/)
  // 冪等：同一份名單再報一次，沒有新夥伴
  assert.deepEqual(ids(await sync('N1', [{ name: '甲', session_id: S1, engine: 'claude' }])), { 甲: A })
  assert.equal((await q('select count(*)::int c from relay.partners'))[0].c, 1)
  // 規則 1：同 session 改名，舊名記下
  assert.deepEqual(ids(await sync('N1', [{ name: '乙', session_id: S1 }])), { 乙: A })
  assert.deepEqual(await q('select name from relay.partner_names'), [{ name: '甲' }])
  // 轉寄期：舊名 7 天內解析得到，過期解析不到；別台解析不到
  assert.equal((await q(`select relay.partner_resolve('N1','甲') r`))[0].r, A)
  assert.equal((await q(`select relay.partner_resolve('N1','乙') r`))[0].r, A)
  assert.equal((await q(`select relay.partner_resolve('N2','乙') r`))[0].r, null)
  await db.exec(`update relay.partner_names set renamed_at = now() - interval '8 days'`)
  assert.equal((await q(`select relay.partner_resolve('N1','甲') r`))[0].r, null)
  // 規則 2：同名換 session＝同一位，記交接；沒帶 session（舊橋）不動
  assert.deepEqual(ids(await sync('N1', [{ name: '乙', session_id: S2 }])), { 乙: A })
  assert.deepEqual(await q('select session_id, ended_at is null as cur from relay.partner_sessions order by session_id'),
    [{ session_id: S1, cur: false }, { session_id: S2, cur: true }])
  assert.deepEqual(ids(await sync('N1', [{ name: '乙' }])), { 乙: A })
  assert.equal((await q('select current_session s from relay.partners'))[0].s, S2)
  // 規則 3：名字與 session 都換＝新夥伴
  assert.notEqual(ids(await sync('N1', [{ name: '丙', session_id: S3 }]))['丙'], A)
  // 規則 4：同台兩個同名＝不處理
  assert.deepEqual((await sync('N1', [{ name: '丁', session_id: 'sess-x1-0000' }, { name: '丁', session_id: 'sess-x2-0000' }])).partners, [])
  assert.equal((await q(`select count(*)::int c from relay.partners where current_name = '丁'`))[0].c, 0)
  // 舊 session 接回來（名字也變）＝同一位
  assert.deepEqual(ids(await sync('N1', [{ name: '戊', session_id: S1 }])), { 戊: A })
  // 互換名字不撞唯一索引、各自保住夥伴 ID
  const x = ids(await sync('N1', [{ name: 'X', session_id: 'sess-x-0001' }, { name: 'Y', session_id: 'sess-y-0001' }]))
  const sw = ids(await sync('N1', [{ name: 'X', session_id: 'sess-y-0001' }, { name: 'Y', session_id: 'sess-x-0001' }]))
  assert.equal(sw.X, x.Y)
  assert.equal(sw.Y, x.X)
  // 別台同名是不同夥伴
  const other = ids(await sync('N2', [{ name: '戊', session_id: 'sess-zz-0000' }]))['戊']
  assert.notEqual(other, A)
  // 寄信當下解析：收寄雙方；找不到就是空
  await db.exec(`insert into relay.messages(from_node, from_agent, to_node, to_agent, body) values ('N2','戊','N1','戊','hi'), ('N2', null, 'N1', '沒這人', 'x')`)
  const m = await q('select from_partner_id f, to_partner_id t, to_agent from relay.messages')
  assert.deepEqual(m.find(r => r.to_agent === '戊'), { f: other, t: A, to_agent: '戊' })
  assert.equal(m.find(r => r.to_agent === '沒這人').t, null)
  // 壞輸入
  assert.deepEqual(await sync('N1', [{ name: '' }]), { error: 'bad_request' })
  assert.deepEqual(await sync('N1', [{ name: 'a\nb' }]), { error: 'bad_request' })
  assert.deepEqual(await sync('NX', []), { error: 'not_found' })
  assert.deepEqual(await sync('N1', []), { partners: [] })
})
