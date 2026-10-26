// 內建終端機用的 WezTerm 隨 Windows 安裝檔附帶：版本固定、雜湊核對、只取 6 個檔，設定與下載腳本要一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { WEZTERM_FILES, WEZTERM_VERSION, WEZTERM_ZIP_SHA256, WEZTERM_LICENSE_SHA256, wezTermReady } from '../scripts/fetch-wezterm.mjs'
import os from 'node:os'
import path from 'node:path'

const read = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('版本與雜湊寫死：20240203 穩定版，雜湊是 64 位十六進位', () => {
  assert.equal(WEZTERM_VERSION, '20240203-110809-5046fc22')
  assert.match(WEZTERM_ZIP_SHA256, /^[0-9a-f]{64}$/)
  assert.match(WEZTERM_LICENSE_SHA256, /^[0-9a-f]{64}$/)
})

test('只附 6 個必要檔（不附 mux-server、除錯檔、mesa 軟體算圖），加上授權與來源說明', () => {
  assert.deepEqual([...WEZTERM_FILES].sort(), ['OpenConsole.exe', 'conpty.dll', 'libEGL.dll', 'libGLESv2.dll', 'wezterm-gui.exe', 'wezterm.exe'])
})

test('Windows 專屬設定列的資源就是下載腳本取得的那些檔，放在安裝資料夾的 wezterm 底下；通用設定不列（Linux／安卓不該要這些檔）', () => {
  const win = JSON.parse(read('src-tauri', 'tauri.windows.conf.json')).bundle.resources
  const want = Object.fromEntries([...WEZTERM_FILES, 'LICENSE.md', 'SOURCE.txt'].map(f => [`resources/wezterm/${f}`, `wezterm/${f}`]))
  assert.deepEqual(win, want)
  const common = JSON.parse(read('src-tauri', 'tauri.conf.json')).bundle.resources
  assert.ok(!Object.keys(common).some(k => k.includes('wezterm')), '通用設定不能列 WezTerm（Linux、安卓沒有這些檔會建置失敗）')
})

test('下載的檔不進 git；發版與正式建置都會先取得；只在 Windows 取', () => {
  const ig = read('.gitignore')
  assert.match(ig, /^src-tauri\/resources\/$/m); assert.match(ig, /^\.cache\/$/m)
  assert.match(read('scripts', 'release.mjs'), /scripts\/fetch-wezterm\.mjs/)
  assert.match(JSON.parse(read('package.json')).scripts.build, /fetch-wezterm\.mjs/)
  assert.match(read('scripts', 'fetch-wezterm.mjs'), /process\.platform !== 'win32'/)
})

test('建置占位：沒取過時先放空檔讓 Tauri 建置過得去，但空檔不算就緒（發版會重新取得）', () => {
  assert.match(read('src-tauri', 'build.rs'), /ensure_wezterm_placeholders/)
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wez-ready-'))
  try {
    assert.equal(wezTermReady(d), false, '空資料夾')
    for (const f of [...WEZTERM_FILES, 'LICENSE.md', 'SOURCE.txt']) fs.writeFileSync(path.join(d, f), '')
    assert.equal(wezTermReady(d), false, '全是空檔＝占位，不算就緒')
    for (const f of [...WEZTERM_FILES, 'LICENSE.md', 'SOURCE.txt']) fs.writeFileSync(path.join(d, f), 'x')
    assert.equal(wezTermReady(d), true)
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('Rust 預設找安裝資料夾裡的 wezterm；環境變數有設就只認它', () => {
  const rs = read('src-tauri', 'src', 'launch', 'wezterm.rs')
  assert.match(rs, /join\("wezterm"\)/)
  assert.match(rs, /pub fn locate_with\(/)
})
