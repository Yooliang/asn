// #539 之四：模型清單共用（switchModelsFor）、開新夥伴選型號、手機大按鈕列
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CLAUDE_MODELS, GEMINI_MODELS, launchModelChoices, switchModelsFor } from '../ui/lib/model-catalog.mjs'
import { createModelSwitcher } from '../ui/lib/model-switch.mjs'
import { acpSwitchChoices, opDialogText } from '../ui/lib/partner-ops-ui.mjs'
import { BAR_KEYS, PHONE_WHY, WHY_MAX } from '../ui/lib/actionbar.mjs'
import { BAR_ICON, phoneBarSlots, phoneModels, phoneOpsRows, slotTip } from '../ui/lib/mobile-ops.mjs'
import { MODEL_RE } from '../ui/lib/partner-ops.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

test('switchModelsFor：Claude 三個別名、Gemini 一份小清單、pi 原樣回傳查到的、其他回空（手動輸入）', () => {
  assert.equal(switchModelsFor('claude'), CLAUDE_MODELS)
  assert.equal(switchModelsFor('Claude'), CLAUDE_MODELS, '大小寫不拘')
  assert.equal(switchModelsFor('gemini'), GEMINI_MODELS)
  assert.ok(GEMINI_MODELS.length >= 3)
  for (const m of GEMINI_MODELS) { assert.match(m.id, /^gemini-[a-z0-9.-]+$/); assert.match(m.id, MODEL_RE); assert.ok(m.label) }
  const pi = [{ provider: 'xai', model: 'grok-4.7' }]
  assert.equal(switchModelsFor('pi', { piModels: pi }), pi)
  assert.deepEqual(switchModelsFor('pi'), [])
  for (const e of ['grok', 'codex', 'acp', '', undefined]) assert.deepEqual(switchModelsFor(e), [], String(e))
})

test('切換模型與手機都讀 switchModelsFor：Claude 選單、手機清單同一份', () => {
  assert.deepEqual(createModelSwitcher({ transport: {} }).models, switchModelsFor('claude'))
  assert.deepEqual(phoneModels().map(m => m.id), switchModelsFor('claude').map(m => m.id))
  assert.deepEqual(phoneModels('gemini').map(m => m.id), GEMINI_MODELS.map(m => m.id))
})

test('內建通道切換模型：Gemini 有清單（預設目前的，不在清單就第一個）；Grok 沒清單＝手動輸入', () => {
  const gem = { node: 'H', agent: '小格', engine: 'gemini', model: 'gemini-3.8-flash-low' }
  assert.deepEqual(acpSwitchChoices(gem), { models: GEMINI_MODELS, selected: 'gemini-3.8-flash-low' })
  assert.equal(acpSwitchChoices({ ...gem, model: '' }).selected, GEMINI_MODELS[0].id)
  assert.deepEqual(acpSwitchChoices({ ...gem, engine: 'grok' }).models, [])
  assert.deepEqual(acpSwitchChoices({ node: 'H', agent: 'c' }).models, [], 'Claude 不走這條')
  assert.deepEqual(acpSwitchChoices(null).models, [])
  assert.doesNotMatch(opDialogText('model', '小格', '', 'acp', { hasList: true }).lead, /請輸入/, '有清單就不叫人輸入代號')
  assert.match(opDialogText('model', '小格', '', 'acp').lead, /請輸入模型代號/)
})

test('開新夥伴選型號：只在這台、Claude 開成視窗、Gemini 內建通道時出現；其他不出現', () => {
  assert.deepEqual(launchModelChoices('claude', 'term', { local: true }), { show: true, models: CLAUDE_MODELS })
  assert.deepEqual(launchModelChoices('gemini', 'acp', { local: true }), { show: true, models: GEMINI_MODELS })
  for (const [v, r, local] of [['claude', 'term', false], ['claude', 'pi', true], ['gemini', 'term', true], ['grok', 'acp', true], ['codex', 'term', true], ['pi', 'pi', true], ['', '', true]]) {
    assert.deepEqual(launchModelChoices(v, r, { local }), { show: false, models: [] }, `${v}/${r}/${local}`)
  }
})

test('開新夥伴接線：第 2 頁有型號下拉（預設不指定），本機開時帶 model', () => {
  const html = read('ui/list.html'), js = read('ui/list.js')
  assert.match(html, /<label class="partner-model-pick" v-if="launchModel\.show">型號[\s\S]*?<option value="">不指定（照預設）<\/option>[\s\S]*?v-for="m in launchModel\.models"/)
  assert.match(js, /launchModelChoices\(dlgRow\.value\?\.id, partnerRunChoice\.value, \{ local: partnerDlg\.node === info\.node \}\)/)
  assert.match(js, /\.\.\.\(launchModelPick\.value \? \{ model: launchModelPick\.value \} : \{\}\)/)
  assert.match(read('ui/lib/partner-ops-ui.mjs'), /<label class="op-field" v-if="op === 'model' && acpModels\.length">模型/)
  assert.match(read('src-tauri/src/launch/mod.rs'), /pub model: String,/)
})

const F = (over = {}) => ({ id: 'H/小文', node: 'H', agent: '小文', nick: '小文', status: 'idle', ...over })
const OPS = { machines: { H: { online: true, launcher: {} } }, loaded: true, signedIn: true }

test('手機大按鈕：跟電腦版同樣 6 格、同樣順序；手機沒有的反灰並寫原因（20 字內）', () => {
  const s = phoneBarSlots(F(), { callable: true, ops: OPS, manageCount: 3 })
  assert.deepEqual(s.map(x => x.key), BAR_KEYS)
  const by = Object.fromEntries(s.map(x => [x.key, x]))
  assert.equal(by.call.ok, true)
  assert.deepEqual([by.window.ok, by.window.reason], [false, PHONE_WHY.window])
  assert.equal(by.model.ok, true, '切換模型走遠端夥伴管理')
  assert.deepEqual([by.subs.ok, by.subs.reason], [false, PHONE_WHY.subs])
  assert.equal(by.tasks.ok, false)
  assert.equal(by.manage.ok, true)
  for (const x of s) if (!x.ok) { assert.ok(x.reason, x.key); assert.ok(x.reason.length <= WHY_MAX, x.reason) }
  for (const x of s) assert.ok(BAR_ICON[x.key], x.key)
})

test('手機大按鈕：有背景工作顯示件數但列表反灰；ACP 第 2 格是「ACP 模式」；沒語音、離線、沒管理項目都反灰', () => {
  const t = Object.fromEntries(phoneBarSlots(F({ psm: '背景工作 3 件' }), { callable: true, ops: OPS, manageCount: 1 }).map(x => [x.key, x]))
  assert.deepEqual([t.tasks.count, t.tasks.ok, t.tasks.reason], [3, false, PHONE_WHY.tasks])
  const a = Object.fromEntries(phoneBarSlots(F({ engine: 'gemini' }), { callable: true, ops: OPS, manageCount: 1 }).map(x => [x.key, x]))
  assert.deepEqual([a.window.label, a.window.ok], ['ACP 模式', false])
  assert.equal(a.subs.reason, '只有 Claude 有子代理')
  const n = Object.fromEntries(phoneBarSlots(F(), { callable: false, ops: OPS, manageCount: 0 }).map(x => [x.key, x]))
  assert.equal(n.call.ok, false); assert.equal(n.manage.ok, false)
  const off = Object.fromEntries(phoneBarSlots(F({ status: 'offline' }), { callable: true, ops: OPS, manageCount: 1 }).map(x => [x.key, x]))
  assert.equal(off.call.ok, false); assert.equal(off.model.ok, false)
})

test('手機大按鈕：群組只有一顆「群組」；沒選人就沒有按鈕', () => {
  assert.deepEqual(phoneBarSlots({ id: 'room:g1', room: true, nick: '群' }, {}), [{ key: 'group', label: '群組', ok: true, reason: '' }])
  assert.deepEqual(phoneBarSlots(null), [])
  assert.equal(slotTip({ label: '子代理', ok: false, reason: '手機看不到子代理' }), '子代理：手機看不到子代理')
  assert.equal(slotTip({ label: '通話', ok: true, reason: '' }), '通話')
})

test('手機「⋯」選單：拿掉前台／後台與切換模型，其餘照原順序', () => {
  const items = [{ key: 'console' }, { key: 'info' }, { key: 'rename' }, { key: 'model' }, { key: 'close' }]
  assert.deepEqual(phoneOpsRows(items).map(i => i.key), ['info', 'rename', 'close'])
  assert.deepEqual(phoneOpsRows(null), [])
})

test('手機接線：對話頁帶大按鈕列、⋯ 不列 console、ACP 有型號下拉、群組選單同電腦版', () => {
  const mhtml = read('ui/m.html'), mjs = read('ui/m.js'), pane = read('ui/lib/chatpane.mjs'), bar = read('ui/lib/mobile-bar.mjs')
  assert.match(mhtml, /<chat-pane [^>]*:phone-bar="barView" @bar="onBar"/)
  assert.match(pane, /<mobile-bar v-if="phoneBar" :slots="phoneBar" @pick="onBar"><\/mobile-bar>/)
  assert.match(mjs, /const barView = computed\(\(\) => phoneBarSlots\(chatFriend\.value,/)
  assert.doesNotMatch(mjs, /key: 'console', label: BUDDY_CONSOLE_LABEL/)
  assert.match(mhtml, /v-else-if="opsAcp\.models\.length" v-model="ops\.model"/)
  // 反灰用 aria-disabled、點了只顯示原因不送出；名稱與原因放 aria-label／title
  assert.match(bar, /:aria-disabled="s\.ok \? null : 'true'" :aria-label="s\.label" :title="slotTip\(s\)"/)
  assert.doesNotMatch(bar, /:disabled=/)
  assert.match(bar, /if \(!s\.ok\) \{ showTip\(s\); return \}/)
})
