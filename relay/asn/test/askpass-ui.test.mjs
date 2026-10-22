// 密碼小幫手（#26）的畫面端：確認窗的純邏輯、設定「視窗」分類的「密碼小幫手」說明與「複製路徑」，以及前後端接線守門。
// 小幫手與管道本身由 Rust 測試涵蓋（src-tauri/src/askpass/tests.rs、src-tauri/tests/askpass_bin.rs）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { SETTING_OPS, SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { viewModel, countdownText, parseId } from '../ui/lib/askpass-dialog.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

const base = () => ({
  closeTo: 'tray', trayOk: true, autostart: { supported: true, on: false, busy: false },
  accounts: { list: [], current: null, codexLine: '', busy: false, confirmDel: '', msg: '', trustOwn: false, remote: { node: '', devices: [], list: [], loading: false, busy: false, msg: '' } },
})
const render = async st => {
  globalThis.Vue = Vue
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey: 'window' }) }))
}
const ask = (o = {}) => ({ path: 'C:/Users/x/AppData/Local/ASN/asn-askpass.exe', example: 'setx GIT_ASKPASS "C:/Users/x/AppData/Local/ASN/asn-askpass.exe"', copied: false, ...o })

test('確認窗：把後端給的內容整理成畫面，缺的欄位用中文預設，認不得的種類當成輸入密碼', () => {
  const v = viewModel({ kind: 'secret', program: 'git.exe ← bash.exe', cwd: 'C:/work', prompt: "Password for 'x':", seconds_left: 119.9 })
  assert.deepEqual([v.kind, v.title, v.program, v.cwd, v.prompt, v.secondsLeft, v.okText, v.cancelText], ['secret', '有程式要密碼', 'git.exe ← bash.exe', 'C:/work', "Password for 'x':", 119, '確定', '取消'])
  const empty = viewModel(null)
  assert.equal(empty.kind, 'secret')
  assert.ok(empty.program.includes('無法辨識') && empty.cwd.includes('沒有提供') && empty.prompt.includes('沒有提供提示文字'))
  assert.equal(viewModel({ kind: '亂寫' }).kind, 'secret')
  assert.equal(viewModel({ seconds_left: -5 }).secondsLeft, 0)
})

test('確認窗：預留給 #23 的權限詢問沒有輸入欄、按鈕是允許與拒絕', () => {
  const v = viewModel({ kind: 'permission' })
  assert.deepEqual([v.kind, v.okText, v.cancelText], ['permission', '允許', '拒絕'])
})

test('確認窗：倒數文字與網址參數', () => {
  assert.equal(countdownText(125), '還剩 2 分 05 秒，逾時會自動取消')
  assert.equal(countdownText(45), '還剩 45 秒，逾時會自動取消')
  assert.equal(countdownText(0), '時間到，正在取消…')
  assert.equal(parseId('?id=12'), 12)
  for (const bad of ['', '?id=', '?id=0', '?id=-1', '?id=1e3', '?id=abc', '?id=12345678901234567']) assert.equal(parseId(bad), null, bad)
})

test('設定：沒有小幫手資訊就整塊不顯示', async () => {
  assert.ok(!(await render(base())).includes('密碼小幫手'))
  assert.ok(!(await render({ ...base(), askpass: null })).includes('密碼小幫手'))
})

test('設定：顯示一行說明與設定指令，按鈕「複製路徑」送出 askpass-copy，複製後顯示已複製', async () => {
  const html = await render({ ...base(), askpass: ask() })
  assert.ok(html.includes('aria-label="密碼小幫手"') && html.includes('setx GIT_ASKPASS'))
  assert.ok(html.includes('密碼不會經過 AI') && html.includes('ASN 不會自動改你的設定'))
  assert.ok(html.includes('複製路徑') && !html.includes('已複製'))
  assert.ok((await render({ ...base(), askpass: ask({ copied: true }) })).includes('已複製'))
  assert.ok(SettingsPanel.template.includes("act('askpass-copy')"))
})

test('守門：askpass-copy 在指令清單裡、樞紐接得住且複製的是路徑；前端呼叫的命令在 Rust 端都有註冊', () => {
  assert.ok(SETTING_OPS.includes('askpass-copy'))
  const list = read('../ui/list.js')
  assert.ok(list.includes("case 'askpass-copy'") && list.includes("invoke('askpass_helper_info')"))
  assert.ok(list.includes('writeText(askpassInfo.path)'), '複製的是路徑，不是整行指令')
  const lib = read('../src-tauri/src/lib.rs')
  const js = read('../ui/askpass.js')
  for (const cmd of ['askpass_helper_info', 'askpass_info', 'askpass_answer']) assert.ok(lib.includes(`askpass::dialog::${cmd}`), cmd)
  for (const cmd of ['askpass_info', 'askpass_answer']) assert.ok(js.includes(`invoke('${cmd}'`), cmd)
})

test('守門：設定頁面不自動改使用者的環境變數或 git 設定', () => {
  const rs = ['../src-tauri/src/askpass/mod.rs', '../src-tauri/src/askpass/dialog.rs'].map(read).join('\n')
  const code = rs.split('\n').map(l => l.split('//')[0]).join('\n')
  for (const bad of ['setx', 'set_var', 'git config', 'Registry', 'reg add', 'HKEY']) {
    // mod.rs 只在「顯示用的範例字串」裡出現 setx
    const n = code.split(bad).length - 1
    assert.ok(bad === 'setx' ? n === 1 : n === 0, `${bad} 出現 ${n} 次`)
  }
})

test('守門：確認窗頁面的畫面文字是純中文（沒有英文單字夾雜在句子裡）', () => {
  const html = read('../ui/askpass.html')
  const visible = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ').replace(/ASN|AI/g, " ")
  assert.ok(!/[A-Za-z]{2,}/.test(visible), `畫面文字含英文：${visible.match(/[A-Za-z]{2,}/)}`)
  const model = read('../ui/lib/askpass-dialog.mjs').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.split(' // ')[0]).filter(l => !l.trim().startsWith('//')).join('\n')
  const strings = [...model.matchAll(/'([^'\n`]*[\u4e00-\u9fff][^'\n`]*)'/g)].map(m => m[1])
  assert.ok(strings.length >= 8)
  for (const s of strings) assert.ok(!/[A-Za-z]{2,}/.test(s), s)
})

test('守門：安裝程式更新時也會替小幫手讓路（它可能正被 git 呼叫著）', () => {
  const nsh = read('../src-tauri/installer-hooks.nsh')
  assert.ok(nsh.includes('asn-askpass.exe') && nsh.includes('asn-askpass.old'))
  assert.ok(read('../src-tauri/Cargo.toml').includes('name = "asn-askpass"'))
})
