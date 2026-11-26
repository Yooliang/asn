// #2355 P1：型號清單 → 畫面狀態（純函式）。不接畫面。
import { test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CLAUDE_ALIASES, CLAUDE_ALIAS_LABEL, CODE_TEXT, NONE_TEXT, NONE_TEXT_LOCAL, PENDING_TEXT, PENDING_TIMEOUT_MS, UNKNOWN_FAILURE_TEXT, codeText, modelState } from '../ui/lib/remote-models.mjs'

const logs = []
mock.method(console, 'info', (...a) => { logs.push(a.join(' ')) })
afterEach(() => { logs.length = 0 })

const ok = (vendor, ids, extra = {}) => ({ vendor, status: 'ok', models: ids.map(id => ({ id, name: `名 ${id}` })), ...extra })
const src = (...models) => ({ models })

test('沒有 models（舊電腦／舊後台）→ none，不能重試', () => {
  for (const s of [null, undefined, {}, { models: null }, { models: 'x' }]) {
    const r = modelState(s, 'gemini')
    assert.equal(r.state, 'none'); assert.equal(r.note, NONE_TEXT); assert.equal(r.canRetry, false); assert.deepEqual(r.models, [])
    assert.equal(modelState(s, 'gemini', { where: 'remote' }).note, NONE_TEXT)
  }
  const l = modelState(null, 'gemini', { where: 'local' })
  assert.equal(l.state, 'none'); assert.equal(l.note, NONE_TEXT_LOCAL); assert.ok(!l.note.includes('那台'))
  assert.ok(NONE_TEXT.includes('那台電腦'))
})

test('摘要裡沒有這家廠牌 → unavailable（與 none 分開）', () => {
  const r = modelState(src(ok('codex', ['a'])), 'gemini')
  assert.equal(r.state, 'unavailable'); assert.equal(r.note, UNKNOWN_FAILURE_TEXT); assert.equal(r.canRetry, true)
})

test('不認得的 status → unavailable', () => {
  const r = modelState(src({ vendor: 'gemini', status: 'weird', models: [{ id: 'a', name: 'A' }] }), 'gemini')
  assert.equal(r.state, 'unavailable'); assert.deepEqual(r.models, [])
  assert.ok(logs.some(l => l.includes('不認得的狀態')))
})

test('ok → ready：有清單、沒有說明；name 當 label，沒有 name 用 id；重複的丟掉', () => {
  const r = modelState(src({ vendor: 'gemini', status: 'ok', models: [{ id: 'm1', name: ' 甲 ' }, { id: 'm2' }, { id: 'm1', name: 'dup' }] }), 'gemini')
  assert.equal(r.state, 'ready'); assert.equal(r.note, ''); assert.equal(r.canRetry, false)
  assert.deepEqual(r.models, [{ id: 'm1', label: '甲' }, { id: 'm2', label: 'm2' }])
})

test('壞代號丟掉並記 log；全壞 → unavailable', () => {
  const r = modelState(src(ok('gemini', ['good', '-bad', 'a/../b', 'x'.repeat(101), '', 'a b'])), 'gemini')
  assert.deepEqual(r.models.map(m => m.id), ['good'])
  assert.ok(logs.some(l => l.includes('5 筆格式不正確')))
  const all = modelState(src(ok('gemini', ['-bad', '..'])), 'gemini')
  assert.equal(all.state, 'unavailable'); assert.ok(all.note.startsWith(UNKNOWN_FAILURE_TEXT))
})

test('ok 但清單是空的 → unavailable', () => {
  assert.equal(modelState(src(ok('gemini', [])), 'gemini').state, 'unavailable')
})

test('stale：依 age_s 寫分鐘／小時；不到 1 分鐘不寫；沒有 age_s 寫籠統句；代碼不上畫面', () => {
  const mk = (age) => modelState(src(ok('gemini', ['a'], { stale: true, code: 'timeout', ...(age === undefined ? {} : { age_s: age }) })), 'gemini')
  assert.equal(mk(600).state, 'stale'); assert.equal(mk(600).note, '清單是 10 分鐘前讀到的，剛才重新讀取失敗')
  assert.equal(mk(600).canRetry, true)
  assert.equal(mk(59).note, '')
  assert.equal(mk(60).note, '清單是 1 分鐘前讀到的，剛才重新讀取失敗')
  assert.equal(mk(7300).note, '清單是 2 小時前讀到的，剛才重新讀取失敗')
  assert.equal(mk(undefined).note, '清單不是最新的，剛才重新讀取失敗')
  assert.ok(!mk(600).note.includes('timeout'))
  assert.equal(mk(600).models.length, 1)
})

test('pending：只有說明；沒給 launcherAt 不判斷逾時', () => {
  const s = src({ vendor: 'gemini', status: 'pending', models: [] })
  const r = modelState(s, 'gemini', { now: Date.now() })
  assert.equal(r.state, 'pending'); assert.equal(r.note, PENDING_TEXT); assert.deepEqual(r.models, [])
})

test('pending 超過 10 分鐘（以 launcher_at 為準）→ unavailable；剛好 10 分鐘還是 pending；ISO 字串、Date 都行', () => {
  const s = src({ vendor: 'gemini', status: 'pending', models: [] })
  const at = Date.parse('2026-11-26T10:00:00Z')
  assert.equal(modelState(s, 'gemini', { launcherAt: at, now: at + PENDING_TIMEOUT_MS }).state, 'pending')
  const late = modelState(s, 'gemini', { launcherAt: '2026-11-26T10:00:00Z', now: new Date(at + PENDING_TIMEOUT_MS + 1) })
  assert.equal(late.state, 'unavailable'); assert.equal(late.note, `${UNKNOWN_FAILURE_TEXT}：${CODE_TEXT.timeout.remote}`); assert.equal(late.canRetry, true)
  assert.equal(modelState(s, 'gemini', { launcherAt: 'garbage', now: at + 9e9 }).state, 'pending')
})

test('unavailable／error：每個代碼都有白話，廠牌名換進去，代碼本身不出現', () => {
  for (const status of ['unavailable', 'error']) {
    for (const code of Object.keys(CODE_TEXT)) {
      const r = modelState(src({ vendor: 'gemini', status, code, models: [] }), 'gemini')
      assert.equal(r.state, 'unavailable')
      assert.equal(r.note, `${UNKNOWN_FAILURE_TEXT}：${codeText(code, 'Gemini')}`)
      assert.ok(!r.note.includes('{廠牌}'))
      assert.ok(!r.note.includes(code === 'ok' ? '\u0000' : code))
    }
  }
  const st = (code, where) => modelState(src({ vendor: 'gemini', status: 'unavailable', code, models: [] }), 'gemini', where === undefined ? {} : { where }).note
  // 提到電腦的代碼：本機說「這台電腦」、別台說「那台電腦」，兩種各測；不傳 where 等同別台
  assert.equal(st('not_installed', 'local'), '讀不到型號清單：這台電腦沒有安裝 Gemini')
  assert.equal(st('not_installed', 'remote'), '讀不到型號清單：那台電腦沒有安裝 Gemini')
  assert.equal(st('not_installed'), st('not_installed', 'remote'))
  assert.equal(st('not_logged_in', 'local'), '讀不到型號清單：Gemini 還沒登入（登入後再試）')
  assert.equal(st('not_logged_in', 'remote'), '讀不到型號清單：Gemini 還沒登入（到那台電腦登入後再試）')
  assert.equal(st('not_logged_in'), st('not_logged_in', 'remote'))
  // 每個代碼：local 句不含「那台」；說到電腦的 remote 句不含「這台」
  for (const code of Object.keys(CODE_TEXT)) {
    assert.ok(!codeText(code, 'X', 'local').includes('那台'), code)
    assert.ok(!codeText(code, 'X', 'remote').includes('這台'), code)
    assert.equal(codeText(code, 'X'), codeText(code, 'X', 'remote'))
  }
  // pending 逾時、清單是空的，兩種 where 都走到同一套（不說錯台）
  assert.equal(codeText('__proto__', 'X', 'local'), UNKNOWN_FAILURE_TEXT)
  assert.equal(modelState(src({ vendor: 'pi', status: 'error', code: 'spawn_failed', models: [] }), 'pi').note, '讀不到型號清單：讀取失敗')
  assert.equal(modelState(src({ vendor: 'gemini', status: 'error', code: 'zzz', models: [] }), 'gemini').note, UNKNOWN_FAILURE_TEXT)
  assert.equal(modelState(src({ vendor: 'gemini', status: 'error', models: [] }), 'gemini').note, UNKNOWN_FAILURE_TEXT)
  assert.equal(codeText('__proto__'), UNKNOWN_FAILURE_TEXT)
})

test('narrow：濾掉窄規則不收的型號，log 只有廠牌與筆數；不開 narrow 就全留', () => {
  const ids = ['gemini-3.8-flash', 'a/b', 'a:b', 'a@b', 'a+b', 'a[1m]', 'x'.repeat(61), 'x'.repeat(60)]
  const wide = modelState(src(ok('gemini', ids)), 'gemini')
  assert.equal(wide.models.length, ids.length)
  assert.ok(!logs.some(l => l.includes('格式限制')))
  const r = modelState(src(ok('gemini', ids)), 'gemini', { narrow: true })
  assert.deepEqual(r.models.map(m => m.id), ['gemini-3.8-flash', 'x'.repeat(60)])
  const line = logs.find(l => l.includes('格式限制'))
  assert.equal(line, '[型號清單] gemini 有 6 筆因切換模型的格式限制先不列出')
  assert.ok(!ids.slice(1, 6).some(id => line.includes(id)))
})

test('narrow 濾光所有型號 → unavailable', () => {
  assert.equal(modelState(src(ok('gemini', ['a/b'])), 'gemini', { narrow: true }).state, 'unavailable')
})

test('CODE_TEXT：鍵＝Rust Code 的 8 個值（讀原始碼守門）', () => {
  const rs = fs.readFileSync(new URL('../src-tauri/src/agent_tools/models/mod.rs', import.meta.url), 'utf8')
  const from = rs.indexOf('pub enum Code'), to = rs.indexOf('pub fn code_of')
  assert.ok(from > 0 && to > from, '找不到 Code 的定義')
  const body = rs.slice(from, to)
  const codes = [...body.matchAll(/Code::\w+ => "([a-z_]+)"/g)].map(m => m[1])
  assert.equal(codes.length, 8)
  assert.deepEqual(Object.keys(CODE_TEXT).sort(), [...codes].sort())
  for (const k of codes) assert.deepEqual(Object.keys(CODE_TEXT[k]).sort(), ['local', 'remote'], k)
  assert.equal(CODE_TEXT.spawn_failed.local, '讀取失敗')
  assert.equal(CODE_TEXT.spawn_failed.remote, '讀取失敗')
})

test('Claude 別名：與 claude --help 的 --model 說明（fixture）完全一致，順序也一樣', () => {
  const help = fs.readFileSync(new URL('./fixtures/claude-help-model.txt', import.meta.url), 'utf8')
  const found = [...help.matchAll(/'([a-z][a-z0-9-]*)'/g)].map(m => m[1])
  assert.deepEqual(found, [...CLAUDE_ALIASES])
  assert.deepEqual([...CLAUDE_ALIASES], ['fable', 'opus', 'sonnet'])
  assert.equal(CLAUDE_ALIAS_LABEL, '別名（最新版）')
})
