import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CLAUDE_MODELS } from '../ui/lib/model-catalog.mjs'
import { MODEL_QUERY_TIMEOUT_MS, canOfferModelSwitch, confirmText, createModelSwitcher, currentModelLabel, modelFamily, modelMenuState, resultView } from '../ui/lib/model-switch.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

test('模型清單：Opus／Sonnet／Haiku，id 都能直接當 --model', () => {
  assert.deepEqual(CLAUDE_MODELS.map(m => m.id), ['opus', 'sonnet', 'haiku'])
  for (const m of CLAUDE_MODELS) assert.match(m.id, /^[a-z]+$/)
})

test('比對目前模型：別名、完整名稱、後綴都認得，認不得回 null', () => {
  assert.equal(modelFamily('opus'), 'opus')
  assert.equal(modelFamily('claude-sonnet-4-5'), 'sonnet')
  assert.equal(modelFamily('Haiku[1m]'), 'haiku')
  assert.equal(modelFamily('gpt-5'), null)
  assert.equal(modelFamily(undefined), null)
})

test('目前模型的顯示：沒指定＝預設', () => {
  assert.equal(currentModelLabel(undefined), '預設')
  assert.equal(currentModelLabel(null), '預設')
  assert.equal(currentModelLabel(''), '預設')
  assert.equal(currentModelLabel('claude-opus-4-5'), 'Opus')
  assert.equal(currentModelLabel('my-custom'), 'my-custom')
})

test('誰會出現「切換模型」：只有本機的 Claude 視窗', () => {
  const ok = { node: 'H' }
  assert.equal(canOfferModelSwitch(ok, { selfNode: 'H', engine: 'claude' }), true)
  assert.equal(canOfferModelSwitch({ node: 'W' }, { selfNode: 'H', engine: 'claude' }), false, '別台設備')
  assert.equal(canOfferModelSwitch(ok, { selfNode: 'H', engine: 'codex' }), false)
  assert.equal(canOfferModelSwitch({ node: 'H', engine: 'acp' }, { selfNode: 'H', engine: 'claude' }), false, '雲端代理')
  assert.equal(canOfferModelSwitch({ node: 'H', pending: true }, { selfNode: 'H', engine: 'claude' }), false)
  assert.equal(canOfferModelSwitch(null, { selfNode: 'H', engine: 'claude' }), false)
})

test('選單狀態：閒置可選且目前那項打勾；忙碌全部停用並說明；查不到就是 none', () => {
  const idle = modelMenuState({ ok: true, canSwitch: true, idle: true, model: 'opus' })
  assert.equal(idle.state, 'ready')
  assert.equal(idle.current, 'Opus')
  assert.deepEqual(idle.items.map(i => [i.id, i.checked, i.disabled]), [['opus', true, false], ['sonnet', false, false], ['haiku', false, false]])

  const noModel = modelMenuState({ ok: true, canSwitch: true, idle: true })
  assert.equal(noModel.current, '預設')
  assert.ok(noModel.items.every(i => !i.checked), '沒指定模型時沒有任何一項打勾')

  const busy = modelMenuState({ ok: true, canSwitch: true, idle: false, model: 'haiku', reason: '對話進行中，等它閒置再切換' })
  assert.equal(busy.state, 'busy')
  assert.ok(busy.items.every(i => i.disabled))
  assert.match(busy.reason, /閒置/)
  assert.equal(busy.items.find(i => i.id === 'haiku').checked, true)

  for (const q of [null, { ok: false }, { ok: true, canSwitch: false, reason: '找不到這個夥伴的 Claude 視窗' }]) {
    const n = modelMenuState(q)
    assert.equal(n.state, 'none')
    assert.deepEqual(n.items, [])
    assert.ok(n.reason)
  }
})

test('確認文字：講清楚會關掉原視窗、正在打的字會不見、對話接續', () => {
  const t = confirmText('小良哥', 'Opus', 'Sonnet')
  assert.match(t.lead, /小良哥.*Opus.*Sonnet/)
  const all = t.points.join('\n')
  assert.match(all, /關掉原本的視窗/)
  assert.match(all, /正在打的字會不見/)
  assert.match(all, /對話內容會接續/)
})

test('結果整理：成功一句話；失敗帶原因與手動指令', () => {
  assert.deepEqual(resultView({ ok: true }, 'Sonnet'), { ok: true, message: '已切換為 Sonnet', manual: '' })
  const f = resultView({ ok: false, reason: '原視窗沒有關掉', manual: "Set-Location -LiteralPath 'D:\\x'; & 'claude'", closed: false })
  assert.equal(f.ok, false)
  assert.equal(f.message, '原視窗沒有關掉')
  assert.match(f.manual, /Set-Location/)
  assert.equal(resultView(null).message, '切換失敗')
})

test('控制器：查詢→執行；執行時帶的是查詢回來的 pid 與 sessionId', async () => {
  const calls = []
  const transport = {
    modelSwitchQuery: async req => { calls.push(['q', req]); return { ok: true, canSwitch: true, idle: true, model: 'opus', pid: 220, sessionId: 'sid-1' } },
    modelSwitchRun: async req => { calls.push(['r', req]); return { ok: true, newPid: 500 } },
  }
  const sw = createModelSwitcher({ transport })
  const st = await sw.query('小良哥')
  assert.equal(st.state, 'ready')
  const r = await sw.run('小良哥', st, 'sonnet')
  assert.deepEqual(r, { ok: true, message: '已切換為 Sonnet', manual: '' })
  assert.deepEqual(calls, [['q', { name: '小良哥' }], ['r', { name: '小良哥', pid: 220, sessionId: 'sid-1', model: 'sonnet' }]])
})

test('控制器：查詢出錯或逾時＝切不了；沒有查詢資料或模型不在清單就不執行', async () => {
  const boom = createModelSwitcher({ transport: { modelSwitchQuery: async () => { throw new Error('x') } } })
  assert.equal((await boom.query('a')).state, 'none')
  assert.ok(MODEL_QUERY_TIMEOUT_MS > 0 && MODEL_QUERY_TIMEOUT_MS < 10000)
  let ran = 0
  const sw = createModelSwitcher({ transport: { modelSwitchRun: async () => { ran++; return { ok: true } } } })
  assert.equal((await sw.run('a', { raw: null }, 'sonnet')).ok, false)
  assert.equal((await sw.run('a', { raw: { pid: 1, sessionId: 's' } }, 'gpt')).ok, false)
  assert.equal(ran, 0)
})

test('控制器：執行拋錯＝失敗並帶原因', async () => {
  const sw = createModelSwitcher({ transport: { modelSwitchRun: async () => { throw new Error('操作逾時') } } })
  const r = await sw.run('a', { raw: { pid: 1, sessionId: 's' } }, 'haiku')
  assert.equal(r.ok, false)
  assert.equal(r.message, '操作逾時')
})

test('接線：前端 transport、Rust 指令註冊、名單右鍵選單都有', () => {
  const tauri = read('ui/lib/tauri.mjs')
  assert.match(tauri, /modelSwitchQuery: req => invoke\('model_switch_query', \{ req \}\)/)
  assert.match(tauri, /modelSwitchRun: req => invoke\('model_switch_run', \{ req \}\)/)
  const lib = read('src-tauri/src/lib.rs')
  assert.match(lib, /async fn model_switch_query/)
  assert.match(lib, /async fn model_switch_run/)
  assert.match(lib, /generate_handler!\[[^\]]*model_switch_query, model_switch_run/s)
  const html = read('ui/list.html')
  assert.match(html, /<li v-if="it\.key === 'model' && !buddyIsPi" class="model-sub">/, '切換模型固定出現（不再靠 buddyModel.show 決定有沒有這一項）')
  assert.match(html, /<small class="menu-why" id="buddy-why-model" v-if="!buddySubEnabled && buddyWhyOf\('model'\)">\{\{ buddyWhyOf\('model'\) \}\}<\/small>/, '不能用時原因寫在項目下面')
  assert.match(html, /@click="pickBuddyModel\(m\)"/)
  assert.match(html, /v-if="modelDlg\.open"/)
  const js = read('ui/list.js')
  assert.match(js, /from '\.\/lib\/model-switch\.mjs'/)
  assert.match(js, /submitModelDlg/)
})

test('守門：要先確認才會執行（確認鈕才呼叫 run；選單點選只開確認窗）', () => {
  const js = read('ui/list.js')
  const pick = js.slice(js.indexOf('function pickBuddyModel'), js.indexOf('async function submitModelDlg'))
  assert.doesNotMatch(pick, /modelSwitcher\.run/, '點選單不能直接執行')
  assert.match(js.slice(js.indexOf('async function submitModelDlg')), /modelSwitcher\.run\(/)
})

test('確認窗：使用者自己開的視窗多一句說明終端機分頁會留下；ASN 開的不用', () => {
  const asn = confirmText('小良哥', 'Opus', 'Sonnet')
  const own = confirmText('小良哥', 'Opus', 'Sonnet', { ownWindow: true })
  assert.equal(own.points.length, asn.points.length + 1)
  assert.match(own.points.at(-1), /你自己開的視窗.*分頁會留下/)
  assert.ok(!asn.points.some(x => x.includes('你自己開的')))
  assert.ok(!/node|pid|[A-Z]{2,}\d/i.test(own.points.join('')), '不顯示節點代號')
})

test('列表右鍵把後端的 ownWindow 傳進確認窗', () => {
  const list = read('ui/list.js')
  assert.match(list, /confirmText\(modelDlg\.name[^\n]*ownWindow: Boolean\(modelDlg\.st\?\.raw\?\.ownWindow\)/)
})
