// #2425 PR-4：名單頁的提示搬家。
// 環境變數提醒（env-notice）改放設定頁終端區、設備群組上純資訊的 tooltip 拿掉、電腦換名失敗改走結果提示、封存失敗原文寫進 log。
// 階級＝知道就好；範圍＝這台電腦；位置＝設定頁終端區（欄位說明）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Vue from 'vue'
import { renderToString as ssrRender } from 'vue/server-renderer'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { runArchive } from '../ui/lib/archive.mjs'

const UI = fileURLToPath(new URL('../ui/', import.meta.url))
const read = p => fs.readFileSync(path.join(UI, p), 'utf8').replace(/\r\n/g, '\n')

const base = () => ({
  closeTo: 'tray', trayOk: true, autostart: { supported: true, on: false, busy: false },
  accounts: { list: [], current: null, codexLine: '', busy: false, confirmDel: '', msg: '', trustOwn: false, remote: { node: '', devices: [], list: [], loading: false, busy: false, msg: '' } },
})
const bridge = (o = {}) => ({ enabled: true, running: true, legacy: false, takeoverAllowed: false, remoteLaunch: false, autoResume: true, error: '', busy: false, confirm: false, termServerSupported: true, termServer: true, termServerActive: true, termServerLocked: false, ...o })
const render = async st => {
  globalThis.Vue = Vue
  return (await ssrRender(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey: 'window' }) }))).replace(/<!--\[-->|<!--\]-->/g, '')
}
const NOTICE = '使用者環境變數裡有 ASN 不傳給夥伴的變數（ASN_RELAY_KEY）。Claude 夥伴不會收到；建議移到別處'

test('名單頁不再有環境提醒黃條、封存提示樣式、換名紅字、設備小點的 tooltip', () => {
  const html = read('list.html')
  assert.doesNotMatch(html, /env-notice|envNotice|archive-note/)
  assert.doesNotMatch(html, /nick-err|nickErr/)
  assert.match(html, /class="dot asn-dot"[^>]*:aria-label="asnBadge\(g\.node\)\.tip"/, '小點本身與讀屏文字照舊')
  assert.doesNotMatch(html, /class="dot asn-dot"[^>]*:title=/, '只放資訊的 tooltip 拿掉')
  const css = read('style.css')
  assert.doesNotMatch(css, /archive-note|env-notice|nick-err/)
})

test('設定頁終端區：有環境變數提醒就顯示後端那一句（資訊級、不帶動作），不看開關', async () => {
  const on = await render({ ...base(), bridge: bridge({ envNotice: NOTICE }) })
  assert.ok(on.includes(NOTICE), '提醒要出現在設定頁')
  assert.match(on, /data-env-notice/)
  assert.ok(!(await render({ ...base(), bridge: bridge({ envNotice: '' }) })).includes('data-env-notice'), '沒有提醒就不放空框')
  // 後端本來就只在這次實際用終端服務時才回這句；剛關開關、還沒重開 ASN 時它仍然成立，畫面不再自己擋
  assert.ok((await render({ ...base(), bridge: bridge({ envNotice: NOTICE, termServer: false }) })).includes(NOTICE), '只看有沒有值，不看開關')
  // 接線一路到底：載入結果寫進 bridge.envNotice → settingsState 的 bridge 物件傳 envNotice → 設定頁讀 st.bridge.envNotice
  // （「每個 st.bridge 欄位都有傳過去」另由 list-bridge-fields.test.mjs 守，那條只比欄位名；這裡補值的來源）
  const js = read('list.js')
  assert.match(js, /loadEnvNotice\(transport\)\.then\(t => \{ bridge\.envNotice = t \}\)/, '查到的值寫進 bridge.envNotice')
  assert.match(js, /bridge: bridge\.shown \? \{[^}]*envNotice: bridge\.envNotice/, '樞紐把提醒交給設定頁')
  assert.match(js, /const bridge = reactive\(\{[^}]*envNotice: ''/, 'bridge 有初值')
  assert.doesNotMatch(js, /envNotice\.value/, '不留舊的獨立 ref')
})

test('電腦換名失敗與啟動對齊的說明走結果提示（at: list），種類跟著 device-rename 給的 ok／fail', () => {
  const js = read('list.js')
  assert.match(js, /const nickNotice = \(text, kind = 'ok'\) => showResult\(kind, text, \{ at: 'list' \}\)/)
  assert.match(js, /followSelfRename\(\{ info, core, me \}, r, nickNotice\)/)
  assert.match(js, /notify: nickNotice/)
  assert.doesNotMatch(js, /nickErr/)
})

test('封存失敗：畫面照舊白話，原始錯誤寫進 log（[ASN] 開頭）', async () => {
  const lines = []
  const orig = console.warn
  console.warn = (...a) => lines.push(a)
  try {
    const r = await runArchive({ partnerArchive: async () => { throw new Error('HTTP 500 boom-original') } }, { node: 'n', agent: 'claude-07' }, true, null)
    assert.equal(r.ok, false)
    assert.ok(!r.text.includes('boom-original'), '畫面不放原文')
    const r2 = await runArchive({ partnerArchive: async () => ({ ok: false, why: 'quota-original' }) }, { node: 'n', agent: 'claude-07' }, true, null)
    assert.equal(r2.text, '封存失敗，請稍後再試')
  } finally { console.warn = orig }
  assert.equal(lines.length, 2)
  assert.ok(lines.every(l => l[0] === '[ASN]'))
  assert.ok(lines[0].join(' ').includes('boom-original'), '例外的原文進 log')
  assert.ok(lines[1].join(' ').includes('quota-original'), '後台回 ok:false 的原文進 log')
})
