// 設定「視窗」分類的「寄信指令」：顯示命令列（asn-cli）的完整路徑與寄信範例，按鈕複製；沒有這個欄位（舊後端）就整塊不顯示。
// 命令列本身（asn-cli send／recv／room／attach）的行為由 Rust 測試涵蓋（src-tauri/src/cli、tests/cli_bin.rs）。
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
const render = async st => {
  globalThis.Vue = Vue
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey: 'window' }) }))
}
const cli = (o = {}) => ({ path: 'C:/Users/x/AppData/Local/ASN/asn-cli.exe', example: 'C:/Users/x/AppData/Local/ASN/asn-cli.exe send --to <節點/視窗名> --body "內文" --no-reply', copied: false, ...o })

test('沒有命令列資訊（舊後端）：整塊不顯示', async () => {
  assert.ok(!(await render(base())).includes('寄信指令'))
  assert.ok(!(await render({ ...base(), cli: null })).includes('寄信指令'))
})

test('顯示完整路徑與寄信範例；複製按鈕送出 cli-copy，複製後顯示「已複製」', async () => {
  const html = await render({ ...base(), cli: cli() })
  assert.ok(html.includes('aria-label="寄信指令"') && html.includes('asn-cli.exe</code>') && html.includes('send --to'))
  assert.ok(html.includes('複製寄信指令') && !html.includes('已複製'))
  assert.ok((await render({ ...base(), cli: cli({ copied: true }) })).includes('已複製'))
  assert.ok(SettingsPanel.template.includes("act('cli-copy')"))
})

test('守門：cli-copy 在指令清單裡、樞紐接得住；前端呼叫的 cli_info 在 Rust 端有註冊；介面文字沒有中英夾雜', () => {
  assert.ok(SETTING_OPS.includes('cli-copy'))
  const list = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  assert.ok(list.includes("case 'cli-copy'") && list.includes("invoke('cli_info')"))
  assert.ok(fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8').includes('cli_info,'))
  const panel = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  const block = panel.slice(panel.indexOf('aria-label="寄信指令"'), panel.indexOf('</section>', panel.indexOf('aria-label="寄信指令"')))
  assert.ok(!/node/i.test(block), '畫面不顯示節點代號')
})
