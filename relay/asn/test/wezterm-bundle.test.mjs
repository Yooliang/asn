// 內建終端機用的 WezTerm 隨 Windows 安裝檔附帶：版本固定、雜湊核對、只取 7 個檔，設定與下載腳本要一致。
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

test('只附 7 個必要檔（含 mux-server；不附除錯檔、mesa 軟體算圖），加上授權與來源說明', () => {
  assert.deepEqual([...WEZTERM_FILES].sort(), ['OpenConsole.exe', 'conpty.dll', 'libEGL.dll', 'libGLESv2.dll', 'wezterm-gui.exe', 'wezterm-mux-server.exe', 'wezterm.exe'])
})

test('mux-server 與其他檔同一個壓縮檔、同一份雜湊核對：腳本取它、來源說明列它、缺檔會明確報錯、建置占位也有它', () => {
  const src = read('scripts', 'fetch-wezterm.mjs')
  assert.ok(WEZTERM_FILES.includes('wezterm-mux-server.exe'))
  assert.match(src, /壓縮檔裡找不到/)
  const sourceText = src.match(/const SOURCE_TEXT = `([^`]*)`/)[1]
  assert.match(sourceText, /wezterm-mux-server\.exe/)
  assert.ok(sourceText.includes('${WEZTERM_ZIP_SHA256}'))
  assert.match(sourceText, /7 個檔/)
  assert.match(read('src-tauri', 'build.rs'), /"wezterm-mux-server\.exe"/)
})

test('安裝掛鉤：WEZTERM_FILES 每個檔更新前都改名（清單一致）；.old 刪不掉就輪替到 .old1～.old9；裝完與解除安裝清 .old*', () => {
  const h = read('src-tauri', 'installer-hooks.nsh')
  const body = name => h.match(new RegExp(name + '\\n([\\s\\S]*?)!macroend'))[1]
  const pre = body('NSIS_HOOK_PREINSTALL')
  // 掛鉤手寫的清單必須與 WEZTERM_FILES 完全一致（新增檔漏列、多列都會紅），編號不重複
  const rows = [...pre.matchAll(/!insertmacro ASN_ROTATE (\d+) (\S+)/g)].map(m => [m[1], m[2]])
  assert.deepEqual(rows.map(r => r[1]).sort(), [...WEZTERM_FILES].sort())
  assert.equal(new Set(rows.map(r => r[0])).size, rows.length, '標籤編號不可重複')
  // 輪替：先刪、刪不掉就試下一個名字（.old、.old1～.old9），只動 wezterm 資料夾
  const rot = h.match(/!macro ASN_ROTATE ID FILE\n([\s\S]*?)!macroend/)[1]
  const sufs = [...rot.matchAll(/ASN_TRY_OLD \$\{ID\} \$\{FILE\} (\.old\d?)/g)].map(m => m[1])
  assert.deepEqual(sufs, ['.old', ...Array.from({ length: 9 }, (_, i) => `.old${i + 1}`)])
  const tryOld = h.match(/!macro ASN_TRY_OLD ID FILE SUF\n([\s\S]*?)!macroend/)[1]
  const iDel = tryOld.indexOf('Delete "$INSTDIR\\wezterm\\${FILE}${SUF}"')
  const iSkip = tryOld.indexOf('IfFileExists "$INSTDIR\\wezterm\\${FILE}${SUF}" +3 0')
  const iRen = tryOld.indexOf('Rename "$INSTDIR\\wezterm\\${FILE}" "$INSTDIR\\wezterm\\${FILE}${SUF}"')
  assert.ok(iDel >= 0 && iSkip > iDel && iRen > iSkip, '先刪、還在就跳過、否則改名')
  assert.match(tryOld, /Goto asn_done_\$\{ID\}/)
  assert.ok(rot.includes('IfFileExists "$INSTDIR\\wezterm\\${FILE}" 0 asn_done_${ID}'), '檔案不存在就略過')
  for (const m of ['NSIS_HOOK_PREINSTALL', 'NSIS_HOOK_POSTINSTALL', 'NSIS_HOOK_POSTUNINSTALL']) {
    assert.ok(body(m).includes('Delete "$INSTDIR\\wezterm\\*.old*"'), `${m} 要清 .old*`)
  }
  assert.ok(!/(taskkill|nsExec|KillProcess)/i.test(h), '掛鉤不殺任何程序')
  const code = h.replace(/^;.*$/gm, '')
  assert.ok(!/\$INSTDIR\\(?!wezterm\\|asn-cli|asn-askpass)[^"]*\.old/.test(code), '只動 wezterm 資料夾與既有的兩個檔')
  const wild = code.split('\n').filter(l => /Delete .*\*/.test(l))
  assert.ok(wild.length >= 3 && wild.every(l => l.includes('Delete "$INSTDIR\\wezterm\\*.old*"')), '萬用字元只能出現在 wezterm 子資料夾路徑下')
  assert.ok(rot.includes('.old9'), '輪替上限到 .old9')
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
