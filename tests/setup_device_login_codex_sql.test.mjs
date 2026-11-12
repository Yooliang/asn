// 手機替電腦登入 Codex 開放（20261113400000_setup_device_login_codex.sql；#933 PR-7）：
// 1. 靜態：只換 setup_kind_version_ok；codex 0.2.17、claude 照舊 0.2.2、其他仍 9999.0.0；回復腳本等於上一版原文。
// 2. 實跑（pglite）：各種類、各版本的結果；0.2.16 的電腦收不到 codex 請求，0.2.17 起收得到；grok、agy 一律不交。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = f => fs.readFileSync(new URL(`../supabase/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const SETUP = rd('migrations/20261102140000_setup_requests.sql')
const PREV = rd('migrations/20261112400000_setup_device_login.sql')
const MIG = rd('migrations/20261113400000_setup_device_login_codex.sql')
const DOWN = rd('sql/rollback/20261113400000_setup_device_login_codex_down.sql')
const grab = (src, start) => { const i = src.indexOf(start); return src.slice(i, src.indexOf('$function$;', i) + '$function$;'.length) }
const FN = 'create or replace function relay.setup_kind_version_ok('

test('靜態：只換 setup_kind_version_ok 一支函式；codex 0.2.17、claude 0.2.2、其他 9999.0.0', () => {
  const code = MIG.replace(/^--.*$/gm, '')
  assert.equal(code.split('create or replace function').length - 1, 1, '只有一支函式')
  assert.doesNotMatch(code, /alter table|drop |grant |create policy|insert |update |delete /i)
  assert.match(grab(MIG, FN), /when 'claude' then array\[0, 2, 2\] when 'codex' then array\[0, 2, 17\] else array\[9999, 0, 0\] end/)
  assert.match(MIG, /revoke all on function relay\.setup_kind_version_ok\(text, text\) from public, anon, authenticated;/)
})

test('靜態：回復腳本放回上一版的原文', () => {
  assert.ok(DOWN.includes(grab(PREV, FN)), '和 20261112400000 的函式一字不差')
  assert.match(DOWN, /revoke all on function relay\.setup_kind_version_ok\(text, text\) from public, anon, authenticated;/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

async function boot(down = false) {
  const db = new PGlite()
  await db.exec('create role service_role; create role anon; create role authenticated; create schema relay;')
  await db.exec(grab(SETUP, 'create or replace function relay.setup_version_ok('))
  await db.exec(grab(PREV, FN))
  await db.exec(MIG)
  if (down) await db.exec(DOWN)
  return async (v, k) => (await db.query('select relay.setup_kind_version_ok($1, $2) ok', [v, k])).rows[0].ok
}

test('實跑：codex 從 0.2.17 起才交；claude 照舊；grok、agy、不認得的一律不交', { skip }, async () => {
  const ok = await boot()
  for (const [v, k, want] of [
    ['0.2.16', 'codex', false], ['0.2.16-test-f7fb90d1', 'codex', false], ['0.2.17', 'codex', true], ['0.2.17-test-abc', 'codex', true],
    ['0.2.20', 'codex', true], ['0.3.0', 'codex', true], ['0.2.2', 'codex', false], ['', 'codex', false], ['x', 'codex', false],
    ['0.2.2', 'claude', true], ['0.2.1', 'claude', false],
    ['0.2.17', 'grok', false], ['0.2.17', 'agy', false], ['0.2.17', 'gemini', false], ['9.9.9', 'grok', false],
  ]) assert.equal(await ok(v, k), want, `${v} ${k}`)
})

test('實跑：回復後 codex 又不交，claude 照舊', { skip }, async () => {
  const ok = await boot(true)
  assert.equal(await ok('0.2.17', 'codex'), false)
  assert.equal(await ok('0.2.2', 'claude'), true)
})
