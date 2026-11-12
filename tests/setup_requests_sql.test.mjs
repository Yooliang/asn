// 手機替新電腦「安裝並登入 Claude Code」的遠端請求（20261102140000_setup_requests.sql；#628 第 4b 段）：
// 1. 靜態：四個 security definer 函式 search_path 空、只授權 service_role；新表開 RLS 沒有 policy。
// 2. 實跑（pglite，沒裝就略過）：只有本人對自己的在線電腦能建立；一個節點一筆、10 分鐘過期、每小時最多 6 次、失敗後 1 分鐘內不能重送；
//    ASN 取走時拿到送出者；結果只動 taken 的那一列；手機看得到自己各節點的狀態。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = fs.readFileSync(new URL('../supabase/migrations/20261102140000_setup_requests.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('靜態：四個函式 security definer、search_path 空、只授權 service_role；新表開 RLS 沒有 policy', () => {
  const sigs = ['asn_setup_request\\(uuid, text\\)', 'asn_setup_status\\(uuid\\)', 'asn_relay_setup_poll\\(text, text\\)', 'asn_relay_setup_result\\(text, boolean, text, text\\)']
  for (const sig of sigs) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${sig} from public, anon, authenticated;`), sig)
    assert.match(sql, new RegExp(`grant execute on function public\\.${sig} to service_role;`), sig)
  }
  assert.equal((sql.match(/security definer\n set search_path to ''/g) ?? []).length, 4)
  assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(sql, /create policy/)
  assert.match(sql, /alter table relay\.setup_requests enable row level security;/)
  assert.match(sql, /revoke all on relay\.setup_requests from public, anon, authenticated;/)
  assert.match(sql, /constraint setup_requests_pkey primary key \(node\)/, '每個節點同時只有一筆')
})

test('靜態：建立請求只收本人（p_user）且節點要是本人的；節點金鑰那邊的函式只動自己節點', () => {
  const fn = (name, next) => sql.slice(sql.indexOf(`function public.${name}(`), next ? sql.indexOf(`function public.${next}(`) : undefined)
  const req = fn('asn_setup_request', 'asn_setup_status')
  assert.match(req, /p_user is null or not exists \(select 1 from relay\.nodes where id = p_node and status = 'active' and owner_user = p_user\)/)
  assert.match(req, /return jsonb_build_object\('error', 'not_found'\)/)
  const poll = fn('asn_relay_setup_poll', 'asn_relay_setup_result')
  const res = fn('asn_relay_setup_result')
  for (const body of [poll, res]) assert.match(body, /node = p_node/)
  assert.doesNotMatch(poll + res, /p_user/, '節點金鑰的函式不收使用者參數')
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟，整支失敗、不會無聲略過
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'

async function boot() {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, status text default 'active', owner_user uuid);
    create table relay.asn_presence(node text, window_name text default 'w', version text, updated_at timestamptz default now());
    create table relay.account_events(id bigint generated always as identity primary key, at timestamptz default now(), user_id uuid, event text not null, node text, detail jsonb);
    insert into relay.nodes(id, owner_user) values ('NEWPC','${U1}'),('N2','${U1}'),('N3','${U1}'),('N4','${U1}'),('N5','${U1}'),('N6','${U1}'),('N7','${U1}'),('OTHER','${U2}'),('OFFLINE','${U1}');
    insert into relay.asn_presence(node, version) select id, '0.2.2' from relay.nodes where id <> 'OFFLINE';`)
  await db.exec(sql.slice(0, sql.indexOf('-- 清理：')) + '\ncommit;')
  const one = async (t, a) => (await db.query(t, a)).rows[0]
  return {
    db,
    request: async (node, user = U1) => (await one('select public.asn_setup_request($1,$2) r', [user, node])).r,
    status: async (user = U1) => (await one('select public.asn_setup_status($1) r', [user])).r,
    poll: async (node, version = '0.2.2') => (await one('select public.asn_relay_setup_poll($1,$2) r', [node, version])).r,
    result: async (node, ok, detail = null, replaced = null) => (await one('select public.asn_relay_setup_result($1,$2,$3,$4) r', [node, ok, detail, replaced])).r,
    row: async node => (await one('select * from relay.setup_requests where node = $1', [node])),
  }
}

test('實跑：本人對自己的在線電腦建立；別人的、不存在的都是 not_found；離線是 asn_offline；重複送回 already', { skip }, async () => {
  const { request, row } = await boot()
  assert.deepEqual(await request('NEWPC'), { ok: true, already: false, state: 'pending' })
  assert.equal((await row('NEWPC')).requested_by, U1)
  assert.deepEqual(await request('NEWPC'), { ok: true, already: true, state: 'pending' })
  assert.equal((await request('OTHER')).error, 'not_found', '別人的節點')
  assert.equal((await request('NOPE')).error, 'not_found')
  assert.equal((await request('NEWPC', U2)).error, 'not_found', '別人送自己的節點也不行')
  assert.equal((await request('NEWPC', null)).error, 'not_found', '沒有使用者（節點金鑰）建立不了')
  assert.equal((await request('OFFLINE')).error, 'asn_offline')
})

test('實跑：版本太舊的 ASN 不能建立（asn_outdated）也不交給它；版本用數字比，不是字串比', { skip }, async () => {
  const { db, request, poll, row } = await boot()
  // 版本檢查是數字比：0.2.10 > 0.2.2，0.10.0 > 0.2.2；0.2.1、0.1.99 不夠
  for (const [v, ok] of [['0.2.2', true], ['0.2.10', true], ['0.10.0', true], ['1.0.0', true], ['0.2.2-beta', true], ['0.2.1', false], ['0.1.99', false], ['0.2.0', false]]) {
    await db.query("update relay.asn_presence set version = $1 where node = 'NEWPC'", [v])
    await db.query('delete from relay.setup_requests')
    await db.query('delete from relay.account_events')
    const r = await request('NEWPC')
    assert.equal(r.error === 'asn_outdated', !ok, `${v} → ${JSON.stringify(r)}`)
  }
  // 取走時也看版本：舊版的視窗來問，請求留著，不會被吃掉；夠新的視窗來問才交
  await db.query("update relay.asn_presence set version = '0.2.2' where node = 'NEWPC'")
  await db.query('delete from relay.setup_requests'); await db.query('delete from relay.account_events')
  assert.equal((await request('NEWPC')).ok, true)
  assert.deepEqual(await poll('NEWPC', '0.2.0'), { requested: false })
  assert.equal((await row('NEWPC')).status, 'pending', '舊版問過，請求還在')
  assert.equal((await poll('NEWPC', '0.2.2')).requested, true)
  assert.equal((await row('NEWPC')).status, 'taken')
  // 離線優先於版本：離線就是離線
  assert.equal((await request('OFFLINE')).error, 'asn_offline')
})

test('實跑：每小時最多 6 次；失敗後 1 分鐘內不能重送，之後可以', { skip }, async () => {
  const { db, request, poll, result } = await boot()
  const ids = ['NEWPC', 'N2', 'N3', 'N4', 'N5', 'N6']
  for (const id of ids) assert.equal((await request(id)).ok, true, id)
  assert.equal((await request('N7')).error, 'rate_limited', '第 7 次')
  await db.query("update relay.account_events set at = now() - interval '2 hours'")
  assert.equal((await request('N7')).ok, true, '一小時後可以')
  // 失敗後 1 分鐘內不能重送
  await poll('N7'); await result('N7', false, '失敗')
  assert.equal((await request('N7')).error, 'rate_limited')
  await db.query("update relay.setup_requests set updated_at = now() - interval '2 minutes' where node = 'N7'")
  assert.equal((await request('N7')).ok, true)
})

test('實跑：ASN 取走一次就變 taken 並拿到送出者；沒請求或已取走回 false；過期的 pending 清掉', { skip }, async () => {
  const { db, request, poll, row } = await boot()
  assert.deepEqual(await poll('NEWPC'), { requested: false })
  await request('NEWPC')
  const p = await poll('NEWPC')
  assert.deepEqual(p, { requested: true, requested_by: U1, kind: 'claude' })
  assert.equal((await row('NEWPC')).status, 'taken')
  assert.deepEqual(await poll('NEWPC'), { requested: false }, '只回一次')
  // 別的節點取不到
  await request('N2')
  assert.deepEqual(await poll('N3'), { requested: false })
  // 10 分鐘沒被取走就過期
  await db.query("update relay.setup_requests set requested_at = now() - interval '11 minutes' where node = 'N2'")
  assert.deepEqual(await poll('N2'), { requested: false })
  assert.equal(await row('N2'), undefined)
  // taken 太久沒回報：標成失敗
  await db.query("update relay.setup_requests set updated_at = now() - interval '41 minutes' where node = 'NEWPC'")
  await poll('NEWPC')
  assert.equal((await row('NEWPC')).status, 'failed')
})

test('實跑：結果只動自己節點、只處理 taken 的那一列；原因與重裝說明被截斷成 200 字、控制字元換成空白', { skip }, async () => {
  const { request, poll, result, row } = await boot()
  await request('NEWPC'); await request('N2')
  await result('NEWPC', true)
  assert.equal((await row('NEWPC')).status, 'pending', 'pending 還沒被取走，結果不算數')
  await poll('NEWPC')
  await result('N2', true)
  assert.equal((await row('N2')).status, 'pending', '別的節點的結果不動我的')
  await result('NEWPC', false, 'x'.repeat(300) + '\n', '換\u0007過' + 'y'.repeat(300))
  const r = await row('NEWPC')
  assert.equal(r.status, 'failed')
  assert.equal(r.detail.length, 200)
  assert.ok(!/[\u0000-\u001f]/.test(r.replaced) && r.replaced.length <= 200 && r.replaced.startsWith('換 過'))
  assert.equal((await result('NEWPC', null)).error, 'bad_request')
  await request('N3'); await poll('N3')
  await result('N3', true, null, null)
  assert.equal((await row('N3')).status, 'done')
})

test('實跑：手機看自己帳號下各節點的狀態；別人的節點看不到；過期的 pending 不顯示', { skip }, async () => {
  const { db, request, poll, result, status } = await boot()
  await request('NEWPC'); await request('N2')
  await poll('N2'); await result('N2', true, null, '原本的 claude.exe 簽章或簽署者不對才重新安裝的')
  await db.query("update relay.setup_requests set requested_at = now() - interval '11 minutes' where node = 'NEWPC'")
  const mine = Object.fromEntries((await status()).map(n => [n.id, n.setup]))
  assert.equal(mine.NEWPC, null, '過期的 pending 不顯示')
  assert.equal(mine.N2.state, 'done')
  assert.match(mine.N2.replaced, /簽章或簽署者不對/)
  assert.ok(!('OTHER' in mine), '別人的節點看不到')
  const theirs = (await status(U2)).map(n => n.id)
  assert.deepEqual(theirs, ['OTHER'])
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
