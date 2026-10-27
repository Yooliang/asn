// #351 開新夥伴「運行」四選一（內建通道＞經 pi＞ASN 開的終端＞自己開的 CLI）與「pi 是通道不是廠家」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_CATALOG, RUN_OPTION_LABEL, runOptions, vendorRows } from '../ui/lib/model-catalog.mjs'

const row = id => MODEL_CATALOG.find(m => m.id === id)
const keys = r => r.options.map(o => `${o.key}:${o.ok ? 'ok' : 'no'}`)

test('四個選項照優先序排；自己開的 CLI 始終不能選（#723，只顯示說明）', () => {
  for (const m of MODEL_CATALOG) {
    const r = runOptions(m, { local: true, piInstalled: true, piReady: true })
    assert.deepEqual(r.options.map(o => o.key), ['acp', 'pi', 'term', 'self'], m.id)
    assert.equal(r.options.find(o => o.key === 'self').ok, false, m.id)
    assert.match(r.options.find(o => o.key === 'self').why, /ASN 只負責接手/, m.id)
    for (const o of r.options) { assert.equal(o.label, RUN_OPTION_LABEL[o.key]); if (!o.ok) assert.ok(o.why, `${m.id}.${o.key} 不能選要寫原因`) }
    assert.ok(r.options.find(o => o.key === r.selected).ok, `${m.id} 預設要能選`)
  }
})

test('Grok：這台、裝了 pi、pi 已能帶模型 → 預設內建通道；終端只在這台能開，收不到信', () => {
  const r = runOptions(row('grok'), { local: true, piInstalled: true, piReady: true })
  assert.deepEqual(keys(r), ['acp:ok', 'pi:ok', 'term:ok', 'self:no'])
  assert.equal(r.selected, 'acp')
  assert.match(r.options[2].note, /收不到信/)
  const remote = runOptions(row('grok'), { local: false, piInstalled: true, piReady: true })
  assert.equal(remote.options[2].ok, false); assert.match(remote.options[2].why, /那台電腦/)
})

test('經 pi：沒裝 pi、或 0.1.90 前還不能帶模型，都反灰並寫原因', () => {
  assert.match(runOptions(row('grok'), { local: true, piInstalled: false }).options[1].why, /沒偵測到 pi/)
  assert.match(runOptions(row('grok'), { local: true, piInstalled: true, piReady: false }).options[1].why, /0\.1\.90/)
  assert.equal(runOptions(row('gemini'), { local: true, piInstalled: true, piReady: true }).options[1].ok, false, 'Gemini 經 pi 不支援')
})

test('Claude：沒有內建通道；ASN 開成它自己的視窗（別台也能遠端開），所以預設是終端那一項', () => {
  const r = runOptions(row('claude'), { local: false, piInstalled: false })
  assert.deepEqual(keys(r), ['acp:no', 'pi:no', 'term:ok', 'self:no'])
  assert.equal(r.selected, 'term')
  assert.match(r.options[2].note, /自己的終端機視窗/)
  assert.match(r.options[3].note, /外掛/)
})

test('沒有任何一條可走時沒有預設（null），開啟要反灰；壞資料不丟錯', () => {
  const r = runOptions({ id: 'x', channels: { acp: { status: 'no' }, pi: { status: 'no' }, term: { status: 'no' } } })
  assert.equal(r.selected, null)
  assert.equal(runOptions(undefined).selected, null)
})

test('pi 是通道不是廠家：廠家清單不列 pi，目錄裡仍留著（經 pi 開時要用 pi 的 profile）', () => {
  assert.ok(MODEL_CATALOG.some(m => m.id === 'pi' && m.channelOnly), '目錄留著 pi')
  assert.deepEqual(vendorRows(MODEL_CATALOG).map(m => m.id), ['claude', 'codex', 'gemini', 'grok'])
  assert.deepEqual(vendorRows(null), [])
})

test('沒偵測到 pi 的說明（#394）：講清楚是「沒有 pi」、找過哪些地方、剛裝好要重開 ASN；跟「沒有擴充」分開', () => {
  const why = runOptions(row('grok'), { local: true, piInstalled: false }).options[1].why
  assert.match(why, /沒偵測到 pi（PATH 和 npm、pnpm、scoop 的安裝資料夾都找過）/)
  assert.match(why, /把 ASN 關掉重開/)
  assert.doesNotMatch(why, /擴充/)
})
