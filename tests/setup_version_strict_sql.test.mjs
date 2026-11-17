// 版本比對收緊（20261118100000_setup_version_strict.sql；#1681）：
// 1. 靜態：只有兩支函式的 create or replace ＋ revoke；回復腳本放回兩支函式的上一版原文。
// 2. 實跑（pglite）：舊函式遇到超長版本會丟錯（證明 bug）；新函式回 false；常態版本結果不變；回復後常態版本照舊。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'

const rd = f => fs.readFileSync(new URL(`../supabase/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const SETUP = rd('migrations/20261102140000_setup_requests.sql')
const CODEX = rd('migrations/20261113400000_setup_device_login_codex.sql')
const MIG = rd('migrations/20261118100000_setup_version_strict.sql')
const DOWN = rd('sql/rollback/20261118100000_setup_version_strict_down.sql')
const grab = (src, start) => { const i = src.indexOf(start); return src.slice(i, src.indexOf('$function$;', i) + '$function$;'.length) }
const FN_V = 'create or replace function relay.setup_version_ok('
const FN_K = 'create or replace function relay.setup_kind_version_ok('
const REV_V = 'revoke all on function relay.setup_version_ok(text) from public, anon, authenticated;'
const REV_K = 'revoke all on function relay.setup_kind_version_ok(text, text) from public, anon, authenticated;'

test('靜態：只有兩支函式與各自的 revoke，不碰資料表與權限', () => {
  const code = MIG.replace(/^--.*$/gm, '')
  assert.equal(code.split('create or replace function').length - 1, 2, '只有兩支函式')
  assert.doesNotMatch(code, /alter |drop |grant |create table|create policy|insert |update |delete /i)
  assert.ok(MIG.includes(REV_V) && MIG.includes(REV_K))
  assert.match(grab(MIG, FN_V), /language sql immutable set search_path to ''/)
  assert.match(grab(MIG, FN_K), /language sql immutable set search_path to ''/)
})

test('靜態：回復腳本放回兩支函式的上一版原文', () => {
  assert.ok(DOWN.includes(grab(SETUP, FN_V)), 'setup_version_ok 和 20261102140000 一字不差')
  assert.ok(DOWN.includes(grab(CODEX, FN_K)), 'setup_kind_version_ok 和 20261113400000 一字不差')
  assert.ok(DOWN.includes(REV_V) && DOWN.includes(REV_K))
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟，整支失敗、不會無聲略過
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

async function boot(mode) { // 'old' 舊函式、'new' 套用本 migration、'down' 套用後再回復
  const db = track(new PGlite())
  await db.exec('create role service_role; create role anon; create role authenticated; create schema relay;')
  await db.exec(grab(SETUP, FN_V))
  await db.exec(grab(CODEX, FN_K))
  if (mode !== 'old') await db.exec(MIG)
  if (mode === 'down') await db.exec(DOWN)
  return {
    v: async x => (await db.query('select relay.setup_version_ok($1) ok', [x])).rows[0].ok,
    k: async (x, kind) => (await db.query('select relay.setup_kind_version_ok($1, $2) ok', [x, kind])).rows[0].ok,
  }
}

const LONG = '0.2.99999999999999'
const NORMAL = [
  ['0.2.2', true], ['0.2.1', false], ['0.2.29', true], ['0.2.29-test-f7fb90d1', true], ['0.3.0', true],
  ['0.2.29.1', true], ['0.2.29x', true], ['', false], ['x', false], [null, false],
]
const STRICT = [['0.2.1234567', false], ['99999.0.0', false], [LONG, false]]

test('實跑：舊函式遇到超長版本會丟錯（bug 重現）', { skip }, async () => {
  const o = await boot('old')
  await assert.rejects(o.v(LONG))
  await assert.rejects(o.k(LONG, 'codex'))
})

test('實跑：新函式常態版本不變、超長版本回 false 不丟錯', { skip }, async () => {
  const o = await boot('new')
  for (const [v, want] of [...NORMAL, ...STRICT]) {
    assert.equal(await o.v(v), want, `version_ok ${v}`)
    assert.equal(await o.k(v, 'claude'), want, `kind claude ${v}`)
  }
  for (const [v, k, want] of [
    ['0.2.17', 'codex', true], ['0.2.16', 'codex', false], ['0.2.2', 'claude', true], ['0.2.17', 'grok', false],
    [LONG, 'codex', false], [LONG, 'grok', false], [null, 'codex', false], ['99999.0.0', 'claude', false],
  ]) assert.equal(await o.k(v, k), want, `${v} ${k}`)
})

test('實跑：回復後常態版本照舊', { skip }, async () => {
  const o = await boot('down')
  for (const [v, want] of NORMAL) assert.equal(await o.v(v), want, `version_ok ${v}`)
  assert.equal(await o.k('0.2.17', 'codex'), true)
  assert.equal(await o.k('0.2.16', 'codex'), false)
  assert.equal(await o.k('0.2.2', 'claude'), true)
  await assert.rejects(o.v(LONG))
})

closeAtEnd()
