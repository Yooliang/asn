// test/helpers/render.mjs 的示範與守門：用 happy-dom 真的掛載 SettingsPanel，查詢、模擬操作、收 emit；
// 並確認卸載後不留全域、連續掛兩次互不影響。（T1 實驗，見 issue #1763）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { mountComponent } from './helpers/render.mjs'
import { withIdentity } from './helpers/with-identity.mjs'

const baseState = () => ({
  status: 'online', hasUpload: false, avBusy: false, avMsg: '', version: '9.9.9',
  notify: { toast: true, msg: true, nudge: true, file: true }, skin: 'aero', frame: 'custom', mode: 'merged', dpMode: 'left', toolbar: 'top', bubble: 'none', tabDim: 'device', groupDim: 'status',
  closeTo: 'tray', trayOk: true, autostart: { supported: true, on: false, busy: false },
  autoCheck: true, upd: { checking: false, installing: false, manual: '', status: { tone: 'ok', head: '已是最新版', lines: ['目前版本 9.9.9'] } },
  launch: { tools: [], maxPerHour: 6, cwdList: ['D:/a'], cwdSuggest: [], cwdMsg: '' },
  accounts: { list: [], current: null, remote: { devices: [], list: [] } },
  devices: [
    { key: 'H', label: '家用機', self: true, kind: '電腦', online: true, onlineText: '在線', reportedText: '', empty: '', vendors: [] },
    { key: 'W', label: '工作機', self: false, kind: '電腦', online: true, onlineText: '在線', reportedText: '', empty: '', vendors: [] },
  ].map(withIdentity),
})
const panel = (catKey, extra = {}, st = baseState()) => mountComponent(SettingsPanel, { st, catKey, ...extra })

test('渲染與查詢：用選擇器找得到項目，不靠字串切割', () => {
  const m = panel('update')
  try {
    assert.equal(m.find('input[aria-label="自動檢查更新"]').checked, true, '勾選狀態照 st 顯示')
    assert.equal(m.find('.upd-status b').textContent, '已是最新版')
    assert.equal(m.findAll('section.set-card').length >= 1, true)
    assert.ok(m.findByText('立即檢查'))
  } finally { m.unmount() }
})

test('change：勾選框取消勾選會送出 act(autoCheck, false)；物件參數也原樣送', async () => {
  const m = panel('update')
  try {
    await m.trigger(m.find('input[aria-label="自動檢查更新"]'), 'change', { checked: false })
    assert.deepEqual(m.emitted('act'), [['autoCheck', false]])
  } finally { m.unmount() }
  const n = panel('notify')
  try {
    await n.trigger(n.find('input[aria-label="右下角通知"]'), 'change', { checked: false })
    assert.deepEqual(n.emitted('act'), [['notify', { key: 'toast', on: false }]])
  } finally { n.unmount() }
})

test('click：按鈕送指令；停用中的按鈕不送', async () => {
  const m = panel('update')
  try {
    await m.trigger(m.findByText('立即檢查'), 'click')
    assert.deepEqual(m.emitted('act'), [['check-update', undefined]])
  } finally { m.unmount() }
  const st = baseState(); st.upd.checking = true
  const d = panel('update', {}, st)
  try {
    assert.equal(d.findByText('立即檢查').disabled, true)
    await d.trigger(d.findByText('立即檢查'), 'click')
    assert.deepEqual(d.emitted('act'), [], '停用中的按鈕點了不送')
  } finally { d.unmount() }
})

test('radio 與 select：選外觀、選視窗外框', async () => {
  const m = panel('look')
  try {
    await m.trigger(m.find('input[type=radio][value="line"]'), 'change', { checked: true })
    const sel = m.find('select[aria-label="視窗外框"]')
    assert.deepEqual([...sel.options].map((o) => o.value), ['custom', 'native'])
    await m.trigger(sel, 'change', { value: 'native' })
    assert.deepEqual(m.emitted('act'), [['skin', 'line'], ['frame', 'native']])
  } finally { m.unmount() }
})

test('點列表進細部頁、v-model 輸入框（input 事件）、送出表單', async () => {
  const m = panel('devices')
  try {
    // 設備列表 → 點「家用機」的詳情 → 改名
    assert.equal(m.findAll('button[aria-label^="查看"]').length >= 2, true)
    await m.trigger(m.find('button[aria-label="查看 家用機 的詳情"]'), 'click')
    assert.equal(m.find('section.dv-dev .dv-name').textContent, '家用機', '進了細部頁')
    await m.trigger(m.findByText('改名'), 'click')
    const input = m.find('input[aria-label="這台設備的名字"]')
    assert.equal(input.value, '家用機', 'v-model 把目前名字帶進輸入框')
    await m.trigger(input, 'input', { value: '書房電腦' })
    m.clearEmitted()
    await m.trigger(m.find('form.dv-rename'), 'submit')
    assert.deepEqual(m.emitted('act'), [['device-rename', { node: 'H', name: '書房電腦' }]])
    // 返回列表
    await m.trigger(m.find('button[aria-label="返回"]'), 'click')
    assert.ok(!m.find('section.dv-dev'), '回到列表，細部頁不在了')
  } finally { m.unmount() }
})

test('響應式：st 改了，畫面在下一個 tick 跟著變', async () => {
  let st
  const m = mountComponent(SettingsPanel, (Vue) => ({ st: (st = Vue.reactive(baseState())), catKey: 'update' }))
  try {
    st.autoCheck = false; st.upd.status.head = '有新版本'
    await m.nextTick()
    assert.equal(m.find('input[aria-label="自動檢查更新"]').checked, false)
    assert.equal(m.find('.upd-status b').textContent, '有新版本')
  } finally { m.unmount() }
})

test('卸載後沒有殘留全域；連續掛兩次互不影響', async () => {
  const before = ['window', 'document', 'Vue', 'Node', 'Event'].map((k) => k in globalThis)
  const a = panel('update')
  assert.equal(typeof globalThis.document?.createElement, 'function', '掛載期間有 document')
  assert.equal(globalThis.Vue, a.Vue)
  const b = panel('update')
  assert.notEqual(a.container, b.container)
  await a.trigger(a.find('input[aria-label="自動檢查更新"]'), 'change', { checked: false })
  assert.deepEqual(a.emitted('act'), [['autoCheck', false]])
  assert.deepEqual(b.emitted('act'), [], '另一個掛載沒收到')
  assert.equal(b.find('input[aria-label="自動檢查更新"]').checked, true)
  a.unmount()
  assert.equal(typeof globalThis.document?.createElement, 'function', '還有一個掛載時全域保留')
  b.unmount()
  b.unmount()   // 重複卸載不出錯
  assert.deepEqual(['window', 'document', 'Vue', 'Node', 'Event'].map((k) => k in globalThis), before)
  assert.equal(globalThis.Vue, undefined)
  // 卸載後可以再掛
  const c = panel('about')
  try { assert.ok(c.container.textContent.includes('版本 9.9.9')) } finally { c.unmount() }
  assert.equal('document' in globalThis, false)
})

test('globals 選項：掛載期間設好、卸載後還原', () => {
  const m = mountComponent({ render() { return globalThis.Vue.h('p', String(globalThis.__FAKE__)) } }, {}, { globals: { __FAKE__: 42 } })
  assert.equal(m.container.textContent, '42')
  m.unmount()
  assert.equal('__FAKE__' in globalThis, false)
})
