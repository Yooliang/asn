// #2353 第④階段：Codex 開新夥伴可以選型號（只有本機對話框）。純函式與原始碼守門，不接畫面。
import { test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { PARTIAL_LIST_NOTE, modelState } from '../ui/lib/remote-models.mjs'
import { LAUNCH_MODEL_RUN, NO_ENGINE_NOTE, launchModelChoices } from '../ui/lib/model-catalog.mjs'
import { launchModelView, pickedModel, remoteLaunchModelChoice } from '../ui/lib/remote-launch-models.mjs'
import { createModelLoader } from '../ui/lib/local-models.mjs'
import { buildLaunchRequest } from '../ui/lib/mobile-launch.mjs'
import { existingPartnerNoticeText, modelNotAppliedNoticeText } from '../ui/lib/partner-launch-notify.mjs'

mock.method(console, 'info', () => {})
afterEach(() => {})

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const entry = (extra = {}, ids = ['m-1', 'm-2']) => ({ vendor: 'codex', status: 'ok', code: 'ok', models: ids.map(id => ({ id, name: `名 ${id}` })), ...extra })

test('本機對話框：Codex 開在視窗、profile 明寫 engine codex 才有下拉（kind list，向本機讀）', () => {
  assert.equal(LAUNCH_MODEL_RUN.codex, 'term')
  assert.deepEqual(launchModelChoices('codex', 'term', { engine: 'codex' }), { show: true, kind: 'list', vendor: 'codex', models: [], note: '' })
  assert.equal(launchModelChoices('codex', 'pi', { engine: 'codex' }).show, false, '經 pi 不能帶')
  assert.equal(launchModelChoices('codex', 'term', { engine: 'claude' }).show, false, '寫了別家 engine 的不出')
  const noEngine = launchModelChoices('codex', 'term', { engine: '' })
  assert.equal(noEngine.show, false); assert.equal(noEngine.note, NO_ENGINE_NOTE, '沒寫 engine：說明為什麼沒有下拉')
  assert.equal(launchModelChoices('claude', 'term', { engine: 'codex' }).show, false, 'Claude 不會因為 engine 是 codex 就出下拉')
})

test('別台（手機與電腦版替別台開）：Codex 一律沒有下拉；Claude、Gemini 照舊', () => {
  const launcher = { launch_model: true, profiles: [{ id: 'codex', engine: 'codex' }, { id: 'claude', engine: 'claude' }] }
  const c = remoteLaunchModelChoice(launcher, { id: 'codex', profileId: 'codex' }, 'term')
  assert.deepEqual(c, { show: false, kind: '', vendor: '', models: [], note: '' })
  assert.equal(remoteLaunchModelChoice(launcher, { id: 'claude', profileId: 'claude' }, 'term').show, true)
  // 就算呼叫端漏擋，手機組請求時也不會帶 Codex 的型號
  const req = buildLaunchRequest({ node: 'N', name: '甲', cwd: '/w', first: '', profile: 'codex' }, { run: 'term', row: { id: 'codex', profileId: 'codex' }, launcher, model: 'gpt-x-1' })
  assert.equal('model' in req, false)
})

test('隱藏的型號不在清單：解析只認 list（後端 Rust 測試鎖住）；前端對後端給的清單原樣列、第一項是不指定', () => {
  const v = modelState({ models: [entry()] }, 'codex', { where: 'local', narrow: false })
  assert.deepEqual(v.models.map(m => m.id), ['m-1', 'm-2'])
  const html = read('ui/list.html')
  // 下拉第一項固定「不指定（照預設）」，其後才是清單
  assert.match(html, /<option value="">不指定（照預設）<\/option>\s*<option v-for="m in launchModel\.models"/)
  assert.match(read('ui/m.html'), /<option value="">不指定（照預設）<\/option><option v-for="mo in lchModel\.models"/, '手機同一個寫法')
})

test('清單不保證完整：探測帶 partial 才出那句；沒有標記（含後台丟掉）、非 true 都不出、也不出錯', () => {
  for (const [label, e] of [['partial true', { partial: true }], ['partial true + stale', { partial: true, stale: true, code: 'timeout', age_s: 700 }]]) {
    const v = modelState({ models: [entry(e)] }, 'codex', { where: 'local' })
    assert.equal(v.hint, PARTIAL_LIST_NOTE, label)
    assert.equal(v.models.length, 2)
  }
  for (const extra of [{}, { partial: false }, { partial: 'true' }, { partial: 1 }, { partial: null }]) {
    const v = modelState({ models: [entry(extra)] }, 'codex', { where: 'local' })
    assert.equal(v.hint, '', JSON.stringify(extra)); assert.equal(v.state, 'ready'); assert.equal(v.models.length, 2)
  }
  // 失敗與讀取中沒有清單，不帶那句
  assert.equal(modelState({ models: [{ vendor: 'codex', status: 'error', code: 'timeout', partial: true, models: [] }] }, 'codex', { where: 'local' }).hint, '')
  assert.equal(modelState({ models: [{ vendor: 'codex', status: 'pending', partial: true, models: [] }] }, 'codex', { where: 'local' }).hint, '')
  // 說明是資訊級白話，不寫死任何型號名
  assert.equal(PARTIAL_LIST_NOTE, '清單來自這台的 Codex，預設用的型號可能不在裡面')
  assert.doesNotMatch(PARTIAL_LIST_NOTE, /gpt|[0-9]/i)
})

test('launchModelView 把 hint 帶到畫面；別的 kind 沒有 hint；畫面（電腦、手機）同一個欄位', () => {
  const ready = modelState({ models: [entry({ partial: true })] }, 'codex', { where: 'local' })
  const view = launchModelView({ show: true, kind: 'list', vendor: 'codex', models: [], note: '' }, ready)
  assert.equal(view.hint, PARTIAL_LIST_NOTE); assert.equal(view.models.length, 2)
  assert.equal(launchModelView({ show: true, kind: 'list', vendor: 'codex', models: [], note: '' }, undefined).hint, '', '還沒讀到：沒有說明')
  assert.equal(launchModelView({ show: true, kind: 'aliases', vendor: '', models: [], note: '' }, ready).hint, '')
  assert.match(read('ui/list.html'), /launchModel\.show &amp;&amp; launchModel\.hint/)
  assert.match(read('ui/m.html'), /lchModel\.show && lchModel\.hint/)
})

test('選的型號必須在目前清單裡（沿用 pickedModel）；不在就當不指定', () => {
  const view = launchModelView({ show: true, kind: 'list', vendor: 'codex', models: [], note: '' }, modelState({ models: [entry()] }, 'codex', { where: 'local' }))
  assert.equal(pickedModel(view, 'm-2'), 'm-2')
  assert.equal(pickedModel(view, 'not-listed'), '')
  assert.equal(pickedModel(view, ''), '')
})

test('本機讀 Codex 清單：代號走統一規則（不套切換模型的窄規則），Gemini 仍套', async () => {
  const wide = 'org/model:1'
  const source = { models: [entry({}, ['gpt-a-1', wide]), { vendor: 'gemini', status: 'ok', models: [{ id: 'gpt-a-1', name: 'A' }, { id: wide, name: 'W' }] }] }
  const seen = {}
  const loader = createModelLoader({ fetch: async () => source, onChange: (v, view) => { seen[v] = view }, narrow: v => v !== 'codex' })
  await loader.load('codex'); await loader.load('gemini')
  assert.deepEqual(seen.codex.models.map(m => m.id), ['gpt-a-1', wide])
  assert.deepEqual(seen.gemini.models.map(m => m.id), ['gpt-a-1'], '切換模型的窄規則仍套在其他家')
  const js = read('ui/list.js')
  assert.match(js, /narrow: v => v !== 'codex'/)
  // 本機對話框的 launchModelChoices 呼叫不能加 remote（那會讓 Codex 沒有下拉）
  assert.match(js, /launchModelChoices\(dlgRow\.value\?\.id, dlgAuto\.value\.run, \{ engine: localProfileEngine\(partnerDlg\.profile, remoteLaunchers\.value\[info\.node\]\) \}\)/)
})

test('開窗結果的 model_note：接舊對話沒套用時顯示一句白話；沒有就不多說', () => {
  const note = '接續舊對話，沿用原本的型號，這次選的型號沒有套用'
  const n = modelNotAppliedNoticeText('小乙', note)
  assert.equal(n.title, '型號沒有套用'); assert.equal(n.body, `「小乙」${note}。`)
  assert.doesNotMatch(n.body, /thread|resume|model/i, '畫面不放英文代號')
  const merged = modelNotAppliedNoticeText('小乙', note, { title: '已改用一般視窗', body: '原本那句' })
  assert.deepEqual(merged, { title: '已改用一般視窗', body: `原本那句\n${note}。` })
  const base = { title: '已改用一般視窗', body: '原本那句' }
  assert.equal(modelNotAppliedNoticeText('小乙', '', base), base)
  const ex = existingPartnerNoticeText('小乙', '', false, note)
  assert.equal(ex.title, '夥伴已在跑'); assert.ok(ex.body.endsWith(`${note}。`))
  assert.equal(existingPartnerNoticeText('小乙', '', false).body, '「小乙」已經在跑，已切到前景。', '沒有 model_note 不變')
  // 開窗結果的出口真的有接上
  const js = read('ui/list.js')
  assert.match(js, /opened\.model_note/)
  assert.match(js, /modelNotAppliedNoticeText\(partnerDlg\.name, opened\.model_note\)/)
})

test('後端說明字串與前端用的是同一句（讀 Rust 原始碼比對）', () => {
  const rs = read('src-tauri/src/launch/codex_open.rs')
  const m = rs.match(/MODEL_NOT_APPLIED_NOTE: &str = "([^"]+)"/)
  assert.ok(m, '找不到常數')
  assert.equal(m[1], '接續舊對話，沿用原本的型號，這次選的型號沒有套用')
})
