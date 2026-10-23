// 設定「視窗與系統匣」分類不再顯示命令列（asn-cli 的路徑與寄信範例）：Claude 視窗自己知道怎麼用，使用者不需要看到。
// 命令列本身（asn-cli send／recv／room／attach）的行為由 Rust 測試涵蓋（src-tauri/src/cli、tests/cli_bin.rs）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { SETTING_OPS, SettingsPanel } from '../ui/lib/settings-panel.mjs'

const base = () => ({
  closeTo: 'tray', trayOk: true, autostart: { supported: true, on: false, busy: false },
  cli: { path: 'C:/Users/x/AppData/Local/ASN/asn-cli.exe', example: 'C:/Users/x/AppData/Local/ASN/asn-cli.exe send --to <節點/視窗名>', copied: false },
  launch: { tools: [], maxPerHour: 6, cwdText: '' },
  askpass: { path: 'C:/x/asn-askpass.exe', example: 'setx SSH_ASKPASS "C:/x/asn-askpass.exe"', copied: false },
})
const render = async (st, catKey) => {
  globalThis.Vue = Vue
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey }) }))
}

test('即使後端回報了命令列資訊，視窗與系統匣也不顯示任何命令列', async () => {
  const html = await render(base(), 'window')
  assert.ok(!html.includes('<code') && !html.includes('asn-cli') && !html.includes('寄信指令') && !html.includes('複製寄信指令'))
})

test('守門：寄信指令的複製操作整個拿掉（元件、指令清單、樞紐都沒有）', () => {
  assert.ok(!SETTING_OPS.includes('cli-copy'))
  assert.ok(!SettingsPanel.template.includes('cli-copy'))
  const list = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  assert.ok(!list.includes("case 'cli-copy'") && !list.includes('cliInfo'))
})

test('守門：密碼小幫手仍有設定指令可複製，但收在「啟動設定」的進階（收合）裡', async () => {
  assert.ok(SETTING_OPS.includes('askpass-copy'))
  const html = await render(base(), 'launch')
  assert.ok(html.includes('<details') && html.includes('<summary>進階</summary>') && html.includes('SSH_ASKPASS'))
  assert.ok(!(await render({ ...base(), askpass: null }, 'launch')).includes('密碼小幫手'))
})
