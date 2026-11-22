// #1548 ③：工作資料夾白名單改成清單（每列「移除」、「＋ 加入資料夾…」、建議列「加入」），驗證在後端
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { hasCwd, suggestCwds } from '../ui/lib/launch-prefs.mjs'
import { mountComponent } from './helpers/render.mjs'

const rd = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const state = launch => ({
  status: 'online', hasUpload: false, avBusy: false, avMsg: '', version: '9.9.9',
  notify: { toast: true, msg: true, nudge: true, file: true }, skin: 'aero', frame: 'custom', mode: 'merged', dpMode: 'left', toolbar: 'top', bubble: 'none', tabDim: 'device', groupDim: 'status',
  closeTo: 'tray', trayOk: true, autostart: { supported: true, on: false, busy: false },
  autoCheck: true, upd: { checking: false, installing: false, manual: '', status: { tone: 'ok', head: '已是最新版', lines: [] } },
  launch: { tools: [], maxPerHour: 6, cwdList: [], cwdSuggest: [], cwdMsg: '', msg: '', ...launch },
  accounts: { list: [], current: null, remote: { devices: [], list: [] } },
  devices: [],
})
const mount = launch => mountComponent(SettingsPanel, { st: state(launch), catKey: 'launch' })
const names = m => m.findAll('.launch-cwd-list:not(.suggest) .launch-cwd-path').map(e => e.textContent.trim())

test('清單：一列一個資料夾、每列一顆「移除」，沒有文字框', () => {
  const m = mount({ cwdList: ['D:\\work', 'D:\\Yooliang\\asn'] })
  try {
    assert.deepEqual(names(m), ['D:\\work', 'D:\\Yooliang\\asn'])
    assert.equal(m.findAll('.launch-cwd-list:not(.suggest) button').filter(b => b.textContent.trim() === '移除').length, 2)
    assert.equal(m.findAll('textarea').length, 0)
    assert.ok(m.findByText('＋ 加入資料夾…'))
  } finally { m.unmount() }
})

test('按「移除」：送出 launch-cwd-remove 並帶那一列的路徑', async () => {
  const m = mount({ cwdList: ['D:\\work', 'D:\\Yooliang\\asn'] })
  try {
    await m.trigger(m.findAll('button').find(b => b.getAttribute('aria-label') === '移除 D:\\Yooliang\\asn'), 'click')
    assert.deepEqual(m.emitted('act'), [['launch-cwd-remove', 'D:\\Yooliang\\asn']])
  } finally { m.unmount() }
})

test('按「＋ 加入資料夾…」：送出 launch-cwd-add', async () => {
  const m = mount({})
  try {
    await m.trigger(m.findByText('＋ 加入資料夾…'), 'click')
    assert.deepEqual(m.emitted('act').map(e => e[0]), ['launch-cwd-add'])
  } finally { m.unmount() }
})

test('清單是空的：寫一句該怎麼做；建議列「加入」送出 launch-cwd-suggest', async () => {
  const m = mount({ cwdSuggest: ['D:\\demo'] })
  try {
    assert.ok(m.container.textContent.includes('按「加入資料夾…」選一個'))
    const row = m.find('.launch-cwd-list.suggest li')
    assert.ok(row.textContent.includes('建議：D:\\demo'))
    await m.trigger(row.querySelector('button'), 'click')
    assert.deepEqual(m.emitted('act'), [['launch-cwd-suggest', 'D:\\demo']])
  } finally { m.unmount() }
})

test('錯誤在清單下面原位用白話顯示（role=alert）；沒有錯誤就不出現', () => {
  const m = mount({ cwdList: ['D:\\work'], cwdMsg: '加入資料夾沒有成功：資料夾不存在：D:\\gone' })
  try { assert.equal(m.find('.launch-cwds [role="alert"]').textContent.trim(), '加入資料夾沒有成功：資料夾不存在：D:\\gone') } finally { m.unmount() }
  const n = mount({ cwdList: ['D:\\work'] })
  try { assert.equal(n.findAll('.launch-cwds [role="alert"]').length, 0) } finally { n.unmount() }
})

test('建議資料夾：只列最近用過、還不在清單裡的（Windows 斜線與大小寫算同一個），最多 3 個；已在清單的資料夾不算新增', () => {
  assert.deepEqual(suggestCwds(['D:\\work'], ['d:/work/', 'D:\\a', 'D:\\b', 'D:\\c', 'D:\\d']), ['D:\\a', 'D:\\b', 'D:\\c'])
  assert.deepEqual(suggestCwds([], []), [])
  assert.equal(hasCwd(['D:\\Work'], 'd:/work/'), true)
  assert.equal(hasCwd(['D:\\Work'], 'D:\\other'), false)
})

test('接線：list.js 的三個動作走後端指令、失敗原文進 log 並在畫面顯示、移除失敗後重讀清單', () => {
  const js = rd('ui/list.js')
  assert.match(js, /case 'launch-cwd-add': await addLaunchCwd\(\); break/)
  assert.match(js, /case 'launch-cwd-remove': await removeLaunchCwd\(String\(value \?\? ''\)\); break/)
  assert.match(js, /case 'launch-cwd-suggest': await addSuggestedCwd\(String\(value \?\? ''\)\); break/)
  assert.match(js, /launchPrefs\.cwdAllow = await transport\.launchCwdRemove\(p\)/)
  assert.match(js, /launchCwdMsg\.value = `移除沒有成功：/)
  assert.match(js, /launchCwdMsg\.value = `加入資料夾沒有成功：/)
  assert.match(js, /console\.info\('\[ASN\] 移除工作資料夾'/)
  assert.match(rd('ui/lib/tauri.mjs'), /launchCwdRemove: cwd => invoke\('launch_cwd_remove', \{ cwd \}\)/)
  assert.match(rd('src-tauri/src/lib.rs'), /launch_cwd_candidates, launch_cwd_browse, launch_cwd_remove,/)
})

test('Rust 接線：加入與整份存檔都經過驗證函式；使用時的三道檢查沒被拿掉', () => {
  const mod = rd('src-tauri/src/launch/mod.rs')
  assert.match(mod, /cwds::add_validated\(&data_dir, &cwd\)/)
  assert.match(mod, /cwds::check_prefs_write\(&current, &prefs\)/)
  assert.match(rd('src-tauri/src/launch/config.rs'), /工作資料夾不在允許清單裡/)
  assert.match(rd('src-tauri/src/launch/term.rs'), /fn authorize_cwd/)
  assert.match(rd('src-tauri/src/bridge/launcher.rs'), /const MAX_CWD: usize = 50;/)
  assert.match(rd('src-tauri/src/launch/cwds.rs'), /pub const MAX_ALLOW: usize = 50;/)
})

test('樣式：清單列、按鈕靠右（列內 margin-left:auto）、窄版加入鈕靠右', () => {
  const css = rd('ui/style.css')
  assert.match(css, /\.launch-cwd-list \.aero-btn\{[^}]*margin-left:auto/)
  assert.match(css, /@media \(max-width:560px\)\{\.launch-cwd-add\{justify-content:flex-end\}\}/)
})
