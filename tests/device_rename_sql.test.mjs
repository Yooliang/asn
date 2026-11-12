// 設備名稱統一（20261113500000_device_rename.sql，#1388）。
// 1. 靜態：新函式 security definer、search_path 空、只授權 service_role；回復腳本把 set_self_name 與 cloud_node_rename 換回原文。
// 2. 實跑（pglite）：actor 與要改的那台都要是本人的、啟用中；名字規則；群組顯示名只在等於舊名時跟著改；寫紀錄；頻率限制；
//    set_self_name 在本人改過名後不覆蓋（回 kept）、沒改過照舊；cloud_node_rename 改名後也標本人取的；回復後行為回到原本。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = f => fs.readFileSync(new URL(`../supabase/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const MIG = rd('migrations/20261113500000_device_rename.sql')
const DOWN = rd('sql/rollback/20261113500000_device_rename_down.sql')
const SELF = rd('migrations/20261021000100_node_self_name.sql')
const CLOUD = rd('migrations/20261106120000_cloud_node_rename.sql')
const OWNS = rd('migrations/20261021060000_owner_signed.sql')
const grab = (src, start) => { const i = src.indexOf(start); assert.ok(i >= 0, start); return src.slice(i, src.indexOf('$function$;', i) + '$function$;'.length) }
const body = f => f.slice(f.indexOf('as $function$'))

test('靜態：新函式 security definer、search_path 空、只授權 service_role；沒有開給 anon／authenticated', () => {
  assert.match(MIG, /function public\.asn_device_rename\(p_user uuid, p_actor text, p_node text, p_name text\)[\s\S]*?security definer\s+set search_path to ''/)
  assert.match(MIG, /revoke all on function public\.asn_device_rename\(uuid, text, text, text\) from public, anon, authenticated;/)
  assert.match(MIG, /grant execute on function public\.asn_device_rename\(uuid, text, text, text\) to service_role;/)
  assert.match(MIG, /revoke all on function relay\.device_name_ok\(text\) from public, anon, authenticated;/)
  const code = MIG.replace(/^--.*$/gm, '')
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(code, /create policy/)
  assert.match(code, /asn_user_owns_node\(p_user, p_actor\)[\s\S]*asn_user_owns_node\(p_user, p_node\)/, 'actor 與要改的那台都要核對')
})

test('靜態：回復腳本把 set_self_name、cloud_node_rename 換回原文；drop 新函式與欄位', () => {
  const origSelf = body(grab(SELF, 'create or replace function public.irori_relay_set_self_name('))
  assert.ok(DOWN.includes(origSelf), 'set_self_name 原文（函式本體）')
  assert.ok(DOWN.includes(grab(CLOUD, 'create or replace function public.asn_cloud_node_rename(')), 'cloud_node_rename 原文')
  for (const s of ['drop function if exists public.asn_device_rename(uuid, text, text, text);', 'drop function if exists relay.device_name_ok(text);', 'alter table relay.nodes drop column if exists name_by_owner;']) {
    assert.ok(DOWN.includes(s), s)
  }
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-1111-1111-1111-111111111111'
const T2 = 'bbbbbbbb-2222-2222-2222-222222222222'

async function boot({ down = false } = {}) {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key, owner_user uuid);
    create table relay.nodes(id text primary key, name text, owner_user uuid, tenant_id uuid, status text default 'active', created_via text);
    create table relay.room_members(room_id text, member text, display_name text, primary key (room_id, member));
    create table relay.account_events(id bigint generated always as identity primary key, at timestamptz default now(),
      user_id uuid, event text not null, node text, detail jsonb);
    create table relay.messages(id uuid);
    insert into relay.tenants values ('${T1}', '${U1}'), ('${T2}', '${U2}');
    insert into relay.nodes values ('pc', '40家用', '${U1}', '${T1}', 'active', 'login-device'), ('ph', 'Oppo', '${U1}', '${T1}', 'active', 'login-device'),
      ('c1', 'Grok', '${U1}', '${T1}', 'active', 'cloud-invite'), ('other', '別人的', '${U2}', '${T2}', 'active', 'login-device'),
      ('old', '撤銷的', '${U1}', '${T1}', 'left', 'login-device');
    insert into relay.room_members values ('r1', 'pc', '40家用'), ('r2', 'pc', '自訂'), ('r3', 'pc', null), ('r1', 'pc~asn40', '40家用');`)
  // 前置：上一版的 set_self_name（改名後的名字）、cloud_node_rename、asn_user_owns_node
  await db.exec(grab(SELF, 'create or replace function public.irori_relay_set_self_name(').replace('public.irori_relay_set_self_name', 'public.asn_relay_set_self_name'))
  await db.exec(CLOUD)
  await db.exec(OWNS.slice(OWNS.indexOf('create or replace function public.asn_user_owns_node'), OWNS.indexOf('grant execute on function public.asn_user_owns_node')))
  await db.exec(MIG)
  if (down) await db.exec(DOWN)
  const q = async (t, a) => (await db.query(t, a)).rows
  const rename = async (u, actor, node, name) => (await q('select public.asn_device_rename($1, $2, $3, $4) r', [u, actor, node, name]))[0].r
  const self = async (node, name) => (await q('select public.asn_relay_set_self_name($1, $2) r', [node, name]))[0].r
  const cloud = async (u, node, name) => (await q('select public.asn_cloud_node_rename($1, $2, $3) r', [u, node, name]))[0].r
  const nameOf = async id => (await q('select name, name_by_owner from relay.nodes where id = $1', [id]))[0]
  return { db, q, rename, self, cloud, nameOf }
}

test('實跑：actor 與要改的那台都要是本人的、啟用中；別人的、撤銷的、不存在一律 not_found', { skip }, async () => {
  const { rename, nameOf, q } = await boot()
  assert.equal((await rename(U1, 'pc', 'other', '偷改')).error, 'not_found', '改別人的')
  assert.equal((await rename(U2, 'other', 'pc', '偷改')).error, 'not_found', '別人從他的設備改我的')
  assert.equal((await rename(U1, 'other', 'ph', '偷改')).error, 'not_found', 'actor 不是本人的')
  assert.equal((await rename(U1, 'old', 'ph', 'x')).error, 'not_found', 'actor 已撤銷')
  assert.equal((await rename(U1, 'pc', 'old', 'x')).error, 'not_found', '目標已撤銷')
  assert.equal((await rename(U1, 'pc', 'nope', 'x')).error, 'not_found', '不存在')
  assert.equal((await rename(null, 'pc', 'ph', 'x')).error, 'bad_request', '沒有簽章的使用者')
  assert.deepEqual((await nameOf('other')).name, '別人的')
  assert.equal((await q('select count(*)::int n from relay.account_events'))[0].n, 0)
})

test('實跑：名字規則（去空白、1～40、無控制字元、無零寬或雙向字元、不像指紋）', { skip }, async () => {
  const { rename } = await boot()
  const z = String.fromCharCode(0x200b), rlo = String.fromCharCode(0x202e), bom = String.fromCharCode(0xfeff)
  const bad = [null, '', '   ', 'a'.repeat(41), 'a\nb', 'a\tb', `a${z}b`, `a${rlo}b`, `${bom}x`, 'Oppo 手機（指紋 12d01662）', '指紋', '12d01662', 'x DEAD1EEF', '81be 4164', '81be　4164']
  for (const b of bad) assert.equal((await rename(U1, 'pc', 'ph', b)).error, 'bad_request', JSON.stringify(b))
  for (const ok of ['Oppo 手機', '小良的 Pixel 8', '工作機-2', 'abc 1234', 'a'.repeat(40), '30家用', 'Facade Bedded', '20261112'.slice(0, 7)]) {
    assert.equal((await rename(U1, 'pc', 'ph', ok)).ok, true, ok)
  }
  assert.deepEqual(await rename(U1, 'pc', 'ph', '  手機  '), { ok: true, name: '手機', changed: true })
})

test('實跑：可以從任一台自己的設備改任一台（含自己、手機、雲端代理）；群組顯示名等於舊名才跟著改；寫紀錄', { skip }, async () => {
  const { rename, nameOf, q } = await boot()
  assert.deepEqual(await rename(U1, 'ph', 'pc', '家裡的電腦'), { ok: true, name: '家裡的電腦', changed: true })
  assert.deepEqual(await nameOf('pc'), { name: '家裡的電腦', name_by_owner: true })
  const rooms = await q("select room_id, member, display_name from relay.room_members order by room_id, member")
  assert.deepEqual(rooms.map(r => [r.room_id, r.member, r.display_name]), [['r1', 'pc', '家裡的電腦'], ['r1', 'pc~asn40', '40家用'], ['r2', 'pc', '自訂'], ['r3', 'pc', null]])
  const ev = await q("select user_id, event, node, detail from relay.account_events")
  assert.deepEqual(ev, [{ user_id: U1, event: 'device_renamed', node: 'pc', detail: { from: '40家用', to: '家裡的電腦', by: 'ph', rooms: 1 } }])
  assert.equal((await rename(U1, 'pc', 'pc', '自己改自己')).ok, true)
  assert.equal((await rename(U1, 'pc', 'c1', '雲端 Grok')).ok, true, '雲端代理也可以')
  // 同名：不寫紀錄，但標成本人取的
  assert.deepEqual(await rename(U1, 'pc', 'ph', 'Oppo'), { ok: true, name: 'Oppo', changed: false })
  assert.deepEqual(await nameOf('ph'), { name: 'Oppo', name_by_owner: true })
  assert.equal((await q("select count(*)::int n from relay.account_events where node = 'ph'"))[0].n, 0)
})

test('實跑：同一個帳號 60 秒內最多改 10 次', { skip }, async () => {
  const { rename } = await boot()
  for (let i = 0; i < 10; i++) assert.equal((await rename(U1, 'pc', 'ph', `手機${i}`)).ok, true, String(i))
  assert.equal((await rename(U1, 'pc', 'ph', '第十一次')).error, 'rate_limited')
})

test('實跑：set_self_name 沒改過名照舊覆蓋；本人改過名後不覆蓋、回 kept；撤銷或不存在回 not_found', { skip }, async () => {
  const { rename, self, nameOf } = await boot()
  assert.deepEqual(await self('pc', '新視窗名'), { ok: true })
  assert.equal((await nameOf('pc')).name, '新視窗名')
  await rename(U1, 'ph', 'pc', '家裡的電腦')
  assert.deepEqual(await self('pc', '舊版啟動時的視窗名'), { ok: true, kept: true })
  assert.equal((await nameOf('pc')).name, '家裡的電腦')
  assert.equal((await self('old', 'x')).error, 'not_found')
  assert.equal((await self('nope', 'x')).error, 'not_found')
  assert.equal((await self('pc', '')).error, 'bad_request')
})

test('實跑：cloud_node_rename 改名後也標成本人取的', { skip }, async () => {
  const { cloud, nameOf } = await boot()
  assert.equal((await cloud(U1, 'c1', '雲端')).ok, true)
  assert.deepEqual(await nameOf('c1'), { name: '雲端', name_by_owner: true })
  assert.equal((await cloud(U1, 'pc', 'x')).error, 'not_found', '電腦照舊不走這條')
})

test('實跑：回復後 set_self_name 照舊覆蓋、沒有改名函式與欄位', { skip }, async () => {
  const { q, self } = await boot({ down: true })
  assert.deepEqual(await self('pc', '視窗名'), { ok: true })
  assert.equal((await q("select count(*)::int n from pg_proc where proname = 'asn_device_rename'"))[0].n, 0)
  assert.equal((await q("select count(*)::int n from information_schema.columns where table_name = 'nodes' and column_name = 'name_by_owner'"))[0].n, 0)
})
