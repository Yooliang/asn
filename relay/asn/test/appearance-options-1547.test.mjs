// #1547：電腦版設定「分頁與分組」併進「外觀」；外觀選項依所選外觀只顯示用得到的（藏起來，不是變灰）。
// 定案表（擁有者 11-22 確認，對照表 v2）：現代藏「工具列位置」；LINE 藏「頭像模式」「文字底色」「分頁依」。
// 藏起來只是不顯示：存檔的值不動，切外觀不得寫回任何被藏選項的值。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { SETTING_CATS, SETTING_KEYS, catSummary, lookOptions } from '../ui/lib/settings-cats.mjs'
import { withTabDim } from '../ui/lib/dims.mjs'
import { GH_REFS_LABEL } from '../ui/lib/msg-ref.mjs'
import { mountComponent } from './helpers/render.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// 畫面標記：每個選項在畫面上的 aria-label（外觀是單選，GitHub 是勾選）
const MARK = { skin: '外觀', frame: '視窗外框', mode: '視窗模式', dpMode: '頭像模式', toolbar: '工具列位置', bubble: '文字底色', tabDim: '分頁依', groupDim: '分組依', ghRefs: GH_REFS_LABEL }
// 9 個選項 × 3 種外觀（true＝顯示）。定案表，不從程式取
const TABLE = {
  skin: { aero: true, modern: true, line: true },
  frame: { aero: true, modern: true, line: true },
  mode: { aero: true, modern: true, line: true },
  dpMode: { aero: true, modern: true, line: false },
  toolbar: { aero: true, modern: false, line: true },
  bubble: { aero: true, modern: true, line: false },
  tabDim: { aero: true, modern: true, line: false },
  groupDim: { aero: true, modern: true, line: true },
  ghRefs: { aero: true, modern: true, line: true },
}
const baseState = (skin, extra = {}) => ({ skin, frame: 'custom', mode: 'merged', dpMode: 'right', toolbar: 'bottom', bubble: 'bubble', tabDim: 'engine', groupDim: 'device', ghRefs: false, ...extra })
const shownOn = (m, key) => {
  const sel = key === 'skin' ? '.skin-pick' : key === 'ghRefs' ? `input[aria-label="${MARK.ghRefs}"]` : `select[aria-label="${MARK[key]}"]`
  return m.find(sel) !== null
}

test('#1547 外觀分類顯示的選項：9 個選項 × 3 種外觀逐一對照定案表', () => {
  for (const skin of ['aero', 'modern', 'line']) {
    const m = mountComponent(SettingsPanel, { st: baseState(skin), catKey: 'look' })
    try {
      for (const key of Object.keys(TABLE)) assert.equal(shownOn(m, key), TABLE[key][skin], `${skin} 下「${MARK[key]}」應${TABLE[key][skin] ? '顯示' : '藏起來'}`)
      // 藏起來＝整個不在畫面上，不是變灰
      assert.equal(m.findAll('select[disabled]').length, 0, `${skin}：不再有變灰的選單`)
      assert.equal(m.findAll('.set-note').length, 1, `${skin}：只剩 GitHub 連結那一行說明`)
    } finally { m.unmount() }
    assert.deepEqual(new Set(lookOptions(skin)), new Set(Object.keys(TABLE).filter(k => TABLE[k][skin])), `${skin}：lookOptions 跟定案表一致`)
  }
})

test('#1547 外觀分類裡選項的順序：外觀、視窗外框、視窗模式、頭像模式、工具列位置、文字底色、分頁依、分組依、#編號連結', () => {
  const m = mountComponent(SettingsPanel, { st: baseState('aero'), catKey: 'look' })
  try {
    const labels = m.findAll('select, input[type="checkbox"], .skin-pick').map(el => (el.getAttribute('aria-label') ?? ''))
    assert.deepEqual(labels, [MARK.skin, MARK.frame, MARK.mode, MARK.dpMode, MARK.toolbar, MARK.bubble, MARK.tabDim, MARK.groupDim, MARK.ghRefs])
  } finally { m.unmount() }
})

test('#1547 「分頁與分組」分類不存在；分頁依、分組依出現在外觀', () => {
  assert.ok(!SETTING_KEYS.includes('tabs'))
  assert.ok(!SETTING_CATS.some(c => c.title === '分頁與分組'))
  assert.ok(!/catKey === 'tabs'/.test(read('ui/lib/settings-panel.mjs')), '設定表單不再有 tabs 區塊')
  const m = mountComponent(SettingsPanel, { st: baseState('aero'), catKey: 'look' })
  try { assert.ok(m.find('select[aria-label="分頁依"]') && m.find('select[aria-label="分組依"]')) } finally { m.unmount() }
})

// 模擬名單視窗的 applySetting：只實作跟外觀有關的幾個指令，寫法跟 list.js 一致（分頁依用真的 withTabDim）
const applyOp = (save, op, value) => {
  switch (op) {
    case 'skin': return { ...save, skin: value }
    case 'dpMode': return { ...save, dpMode: value }
    case 'toolbar': return { ...save, toolbar: value }
    case 'bubble': return { ...save, bubble: value }
    case 'tabDim': return { ...save, ...withTabDim(save, value) }
    case 'groupDim': return { ...save, groupDim: value }
    default: return save
  }
}

test('#1547 切到 LINE／現代再切回，被藏選項的值不變（存檔內容不變）', async () => {
  const initial = baseState('aero')
  let save = initial
  let st
  const m = mountComponent(SettingsPanel, Vue => ({ st: (st = Vue.reactive({ ...save })), catKey: 'look' }))
  try {
    const ops = []
    for (const skin of ['line', 'modern', 'line', 'aero', 'modern', 'aero']) {
      m.clearEmitted()
      await m.trigger(m.find(`.skin-pick input[value="${skin}"]`), 'change', { checked: true })
      for (const [op, value] of m.emitted('act')) { ops.push(op); save = applyOp(save, op, value) }
      Object.assign(st, save)   // 後台把存檔送回來
      await m.nextTick()
    }
    assert.deepEqual([...new Set(ops)], ['skin'], '切外觀只送出 skin 一個指令，沒有寫任何被藏選項')
    assert.equal(ops.length, 6)
    assert.deepEqual(save, initial, '切完一圈，存檔跟原來逐欄相同（含 dpMode、toolbar、bubble、tabDim、groupDim）')
  } finally { m.unmount() }
})

test('#1547 切外觀的後台寫法：skin 指令只改 skin，不碰分頁依、分組依與其他被藏的值（list.js）', () => {
  const list = read('ui/list.js')
  assert.ok(list.includes("case 'skin': skin.value = normalizeSkin(value); break"), "applySetting 的 'skin' 只設 skin")
  assert.ok(!/watch\(skin,[^\n]*(dims|ui\.(dpMode|toolbar|bubble))/.test(list), '切外觀的監看不寫回分頁依／分組依／頭像／工具列／底色')
  assert.ok(list.includes('const setTabDim = v => Object.assign(dims, withTabDim(dims, v))') && list.includes("case 'tabDim': setTabDim(value); break"), '只有使用者自己改分頁依才連帶調分組依')
})

test('#1547 LINE 下不放寬「分組依」選項：仍排除存著的分頁依；分頁依藏起來不影響', () => {
  const m = mountComponent(SettingsPanel, { st: baseState('line', { tabDim: 'device', groupDim: 'status' }), catKey: 'look' })
  try {
    const opts = m.findAll('select[aria-label="分組依"] option').map(o => o.getAttribute('value'))
    assert.deepEqual(opts, ['status', 'engine'], 'tabDim=device 時分組只有活躍度、廠商')
  } finally { m.unmount() }
})

test('#1547 分類摘要只列看得到的選項：現代不含工具列位置原值；LINE 不含頭像、底色、分頁依原值', () => {
  const s = { frame: 'custom', mode: 'merged', dpMode: 'right', toolbar: 'bottom', bubble: 'bubble', tabDim: 'engine', groupDim: 'device' }
  const modern = catSummary('look', { ...s, skin: 'modern' })
  assert.doesNotMatch(modern, /工具列/); assert.match(modern, /頭像/); assert.match(modern, /底色/); assert.match(modern, /分頁依廠商/); assert.match(modern, /分組依設備/)
  const line = catSummary('look', { ...s, skin: 'line' })
  assert.doesNotMatch(line, /頭像|底色|分頁依/); assert.match(line, /工具列/); assert.match(line, /分組依設備/)
  const aero = catSummary('look', { ...s, skin: 'aero' })
  for (const w of ['頭像', '工具列', '底色', '分頁依', '分組依']) assert.ok(aero.includes(w), `復古 Aero 摘要要有「${w}」`)
})

test('#1547 文件與紀律：設定值清單沒有「分頁與分組」分類；開發紀律寫了「外觀選項用不到就隱藏」', () => {
  const doc = read('../../docs/設定值清單.md')
  assert.ok(!doc.includes('cat.tabs'))
  assert.ok(!/^## .*（`tabs`）/m.test(doc))
  assert.ok(read('../../docs/開發紀律.md').includes('外觀選項依所選外觀用不到時，改為隱藏、不是變灰（#1547 擁有者定）'))
})
