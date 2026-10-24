// 設定頁「讓 ASN 負責這台的收發室」：預設關、舊版收發室橋在跑時的說明與「改由 ASN 負責」（要再確認一次）。
// 狀態由 Rust 端的 bridge_status 提供；沒有這個欄位（舊後端）就整塊不顯示，其他設定不受影響。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { SETTING_OPS, SettingsPanel } from '../ui/lib/settings-panel.mjs'

const base = () => ({
  closeTo: 'tray', trayOk: true, autostart: { supported: true, on: false, busy: false },
  accounts: { list: [], current: null, codexLine: '', busy: false, confirmDel: '', msg: '', trustOwn: false, remote: { node: '', devices: [], list: [], loading: false, busy: false, msg: '' } },
})
const bridge = (o = {}) => ({ enabled: false, running: false, legacy: false, takeoverAllowed: false, remoteLaunch: false, error: '', busy: false, confirm: false, ...o })
const render = async st => {
  globalThis.Vue = Vue
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey: 'window' }) }))
}

test('沒有收發室狀態（舊後端）：整塊不顯示', async () => {
  assert.ok(!(await render(base())).includes('收發室'))
  assert.ok(!(await render({ ...base(), bridge: null })).includes('收發室'))
})

test('收發室開關固定開啟且不能改：打勾、停用，沒有任何說明或按鈕', async () => {
  const html = await render({ ...base(), bridge: bridge() })
  assert.match(html, /<input type="checkbox" checked disabled[^>]*aria-label="讓 ASN 負責這台的收發室"/)
  assert.ok(!html.includes('舊版收發室橋') && !html.includes('改由 ASN 負責'))
})

test('開著且正在跑：說明由 ASN 負責', async () => {
  const html = await render({ ...base(), bridge: bridge({ enabled: true, running: true }) })
  assert.match(html, /aria-label="讓 ASN 負責這台的收發室"[^>]*checked|checked[^>]*aria-label="讓 ASN 負責這台的收發室"/)
  assert.ok(html.includes('這台的收發室目前由 ASN 負責。'))
})

test('舊版收發室橋在跑：顯示由舊版負責；開關放行才出現「改由 ASN 負責」，按下去先問再做', async () => {
  const off = await render({ ...base(), bridge: bridge({ legacy: true }) })
  assert.ok(off.includes('這台的收發室目前由舊版收發室橋負責。'))
  assert.ok(!off.includes('改由 ASN 負責'), '設定檔沒放行時不顯示按鈕')
  const on = await render({ ...base(), bridge: bridge({ legacy: true, takeoverAllowed: true }) })
  assert.ok(on.includes('改由 ASN 負責') && !on.includes('確定'))
  const ask = await render({ ...base(), bridge: bridge({ legacy: true, takeoverAllowed: true, confirm: true }) })
  assert.ok(ask.includes('要停掉舊版收發室橋，改由 ASN 負責嗎？') && ask.includes('確定') && ask.includes('取消'))
})

test('允許其他設備替這台開新視窗：預設關，打開後勾選；按下去送出 bridge-launch', async () => {
  const off = await render({ ...base(), bridge: bridge() })
  assert.match(off, /<input type="checkbox"(?![^>]*checked)[^>]*aria-label="允許我的其他設備替這台開新視窗"/)
  const on = await render({ ...base(), bridge: bridge({ enabled: true, running: true, remoteLaunch: true }) })
  assert.match(on, /aria-label="允許我的其他設備替這台開新視窗"[^>]*checked|checked[^>]*aria-label="允許我的其他設備替這台開新視窗"/)
  assert.ok(SettingsPanel.template.includes("act('bridge-launch', $event.target.checked)"))
})

test('錯誤訊息照實顯示', async () => {
  assert.ok((await render({ ...base(), bridge: bridge({ error: '這台電腦還沒有節點金鑰，請先登入' }) })).includes('這台電腦還沒有節點金鑰，請先登入'))
})

test('守門：新增的指令都在清單裡，樞紐接得住，Rust 端有註冊對應指令', () => {
  for (const op of ['bridge-launch', 'bridge-takeover', 'bridge-takeover-yes', 'bridge-takeover-no']) assert.ok(SETTING_OPS.includes(op), op)
  const list = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  // bridge_set_enabled 還在 Rust 端註冊，但收發室已固定開啟，前端不再呼叫
  for (const cmd of ['bridge_status', 'bridge_set_remote_launch', 'bridge_takeover']) {
    assert.ok(list.includes(`invoke('${cmd}'`), `前端呼叫 ${cmd}`)
    assert.ok(fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8').includes(`${cmd},`), `lib.rs 註冊 ${cmd}`)
  }
  // 畫面任何地方都不顯示節點代號：新區塊不引用 node
  const panel = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  const block = panel.slice(panel.indexOf('aria-label="收發室"'), panel.indexOf('</section>', panel.indexOf('aria-label="收發室"')))
  assert.ok(!/node/i.test(block))
})
