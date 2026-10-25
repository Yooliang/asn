// pi 擴充第三期（遠端控制 set_model）的純邏輯：請求檔解析、取下一批、寫結果、挑模型、清舊檔。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MODEL_RE, PROVIDER_RE, nextRequests, parseRequest, pickModel, pruneControl, writeResult } from '../control.mjs'

const SID = 'sess-1'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-control-'))
const put = (root, sid, id, obj) => {
  const dir = path.join(root, sid)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${id}.json`), typeof obj === 'string' ? obj : JSON.stringify(obj))
}
const req = (id, extra = {}) => ({ v: 1, id, op: 'set_model', model: 'claude-sonnet-5', at: 1, ...extra })

test('parseRequest：合格的請求；provider 可省略（null）', () => {
  const root = tmp()
  put(root, SID, 'r1', req('r1'))
  put(root, SID, 'r2', req('r2', { provider: 'anthropic', model: 'MiniMax-M3.1-Flash' }))
  assert.deepEqual(parseRequest(path.join(root, SID, 'r1.json'), 'r1'), { id: 'r1', op: 'set_model', model: 'claude-sonnet-5', provider: null, at: 1 })
  assert.equal(parseRequest(path.join(root, SID, 'r2.json'), 'r2').provider, 'anthropic')
})

test('parseRequest：壞 JSON、檔名與 id 不符、不認得的動作、版本不對、模型或提供者含怪字元＝一律不收', () => {
  const root = tmp()
  const bad = {
    broken: '{壞',
    mismatch: req('other'),
    badop: req('badop', { op: 'rm_rf' }),
    badver: req('badver', { v: 2 }),
    nomodel: req('nomodel', { model: undefined }),
    spaces: req('spaces', { model: 'a b' }),
    slash: req('slash', { model: '../x' }),
    shell: req('shell', { model: 'x;calc' }),
    long: req('long', { model: 'x'.repeat(101) }),
    badprov: req('badprov', { provider: 'a/b' }),
    numprov: req('numprov', { provider: 5 }),
  }
  for (const [id, obj] of Object.entries(bad)) {
    put(root, SID, id, obj)
    assert.equal(parseRequest(path.join(root, SID, `${id}.json`), id), null, id)
  }
  assert.equal(parseRequest(path.join(root, SID, 'nope.json'), 'nope'), null, '檔案不存在')
  assert.ok(MODEL_RE.test('gpt-5.6-sol') && MODEL_RE.test('claude-opus-4-8') && MODEL_RE.test('MiniMax-M3.1-Flash'))
  assert.ok(PROVIDER_RE.test('openai-codex') && !PROVIDER_RE.test('a b'))
})

test('nextRequests：依 at 排序、最多 limit 筆；記憶體 seen 與結果檔都會去重；結果檔本身、暫存檔、壞檔不會被當請求', () => {
  const root = tmp()
  put(root, SID, 'b', req('b', { at: 20 }))
  put(root, SID, 'a', req('a', { at: 10 }))
  put(root, SID, 'c', req('c', { at: 30 }))
  put(root, SID, 'done1', req('done1', { at: 5 }))
  writeResult(root, SID, 'done1', { ok: true, model: 'x' })
  put(root, SID, 'junk', '{壞')
  fs.writeFileSync(path.join(root, SID, 'a.json.123.tmp'), 'x')
  const seen = new Set()
  assert.deepEqual(nextRequests(root, SID, seen, 2).map(r => r.id), ['a', 'b'])
  assert.deepEqual(nextRequests(root, SID, seen, 2).map(r => r.id), ['c'], '前一批已記在 seen')
  assert.deepEqual(nextRequests(root, SID, seen, 2), [])
  assert.deepEqual(nextRequests(root, SID, new Set(), 5).map(r => r.id), ['a', 'b', 'c'], '重開 pi（seen 清空）也不會重做已有結果的 done1')
  assert.deepEqual(nextRequests(root, '../evil', new Set()), [], '不合法的 sessionId')
  assert.deepEqual(nextRequests(path.join(root, 'nope'), SID, new Set()), [], '資料夾不存在')
})

test('writeResult：原子寫入（沒有暫存檔殘留）、欄位限長；寫完這筆請求就不會再被取到', () => {
  const root = tmp()
  put(root, SID, 'r1', req('r1'))
  assert.equal(writeResult(root, SID, 'r1', { ok: false, error: 'ambiguous', providers: ['a', 'b'] }, 777), true)
  const names = fs.readdirSync(path.join(root, SID)).sort()
  assert.deepEqual(names, ['r1.json', 'r1.result.json'])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, SID, 'r1.result.json'), 'utf8')), { v: 1, id: 'r1', ok: false, at: 777, error: 'ambiguous', providers: ['a', 'b'] })
  assert.deepEqual(nextRequests(root, SID, new Set()), [])
  assert.equal(writeResult(root, SID, '../x', { ok: true }), false)
  assert.equal(writeResult(root, 'bad/sid', 'r1', { ok: true }), false)
  writeResult(root, SID, 'r2', { ok: true, model: 'm'.repeat(300), provider: 'p'.repeat(300) })
  const r2 = JSON.parse(fs.readFileSync(path.join(root, SID, 'r2.result.json'), 'utf8'))
  assert.equal(r2.ok, true); assert.equal(r2.model.length, 100); assert.equal(r2.provider.length, 50)
})

test('pickModel：精確比對／只給模型代號時剛好一個才算；多個提供者＝ambiguous；沒金鑰＝no_api_key；沒有＝not_found', () => {
  const M = (provider, id) => ({ provider, id })
  const available = [M('anthropic', 'claude-sonnet-5'), M('xai', 'grok-4.7'), M('a', 'dup'), M('b', 'dup')]
  const all = [...available, M('openai-codex', 'gpt-6-sol')]
  assert.deepEqual(pickModel({ available, all }, null, 'grok-4.7'), { model: available[1] })
  assert.deepEqual(pickModel({ available, all }, 'anthropic', 'claude-sonnet-5'), { model: available[0] })
  assert.deepEqual(pickModel({ available, all }, 'a', 'dup'), { model: available[2] })
  assert.deepEqual(pickModel({ available, all }, null, 'dup'), { error: 'ambiguous', providers: ['a', 'b'] })
  assert.deepEqual(pickModel({ available, all }, null, 'gpt-6-sol'), { error: 'no_api_key' })
  assert.deepEqual(pickModel({ available, all }, 'xai', 'claude-sonnet-5'), { error: 'not_found' }, '提供者不對')
  assert.deepEqual(pickModel({ available, all }, null, 'nope'), { error: 'not_found' })
  assert.deepEqual(pickModel({}, null, 'x'), { error: 'not_found' })
})

test('pruneControl：太舊的請求與結果清掉，新的留著', () => {
  const root = tmp()
  put(root, SID, 'old', req('old'))
  put(root, SID, 'new', req('new'))
  const old = Date.now() - 10 * 24 * 3600 * 1000
  fs.utimesSync(path.join(root, SID, 'old.json'), old / 1000, old / 1000)
  pruneControl(root, SID, Date.now(), 7 * 24 * 3600 * 1000)
  assert.deepEqual(fs.readdirSync(path.join(root, SID)), ['new.json'])
  pruneControl(root, 'bad/sid', Date.now(), 1)
})

test('接線：擴充入口有呼叫 registerInbox、定義了用到的常數與 homedir（#235 之前它們是缺的，真的 pi 載入後不登記視窗）', () => {
  const ts = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
  assert.match(ts, /import \{ homedir \} from 'node:os'/)
  for (const c of ['HEARTBEAT_MS', 'POLL_MS', 'DONE_KEEP_MS']) assert.match(ts, new RegExp(`const ${c} = `), c)
  assert.match(ts, /export default function \(pi: ExtensionAPI\) \{\s*registerInbox\(pi\)/)
  assert.match(ts, /pi\.setModel\(picked\.model\)/)
  assert.match(ts, /pi-control/)
})
