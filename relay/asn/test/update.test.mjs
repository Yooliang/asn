// 自動更新：版本比較、通知文字、狀態機、latest.json 產生、發版參數；以及接線守門（設定、Rust 指令、--shot 不檢查、私鑰不進 repo）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CHECK_MS, autoCheckFromSaved, compareVersions, firstLine, initialUpdateState, isNewer, manualResultText, progressText, updateNoticeText, withAvailable, withFailure, withInstalling, withProgress } from '../ui/lib/update.mjs'
import { PLATFORM, buildLatestJson, changelogFirstSection, installerName, installerUrl, parseArgs, pickNotes } from '../scripts/release-lib.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

test('版本比較：逐段數字比，不是字串比；格式不對不當成較新', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1)
  assert.equal(compareVersions('0.1.8', '0.1.8'), 0)
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1)
  assert.equal(compareVersions('v1.0.0', '0.9.9'), 1)
  assert.equal(isNewer('0.1.9', '0.1.8'), true)
  assert.equal(isNewer('0.1.8', '0.1.8'), false)
  assert.equal(isNewer('0.1.7', '0.1.8'), false)
  for (const bad of ['', 'abc', '1.2', '1.2.3-beta', null, undefined]) assert.equal(isNewer(bad, '0.1.8'), false, String(bad))
})

test('檢查頻率 6 小時；自動檢查預設開，只有明確 false 才關', () => {
  assert.equal(CHECK_MS, 21_600_000)
  assert.equal(autoCheckFromSaved(undefined), true)
  assert.equal(autoCheckFromSaved(JSON.parse('{"sound":true}').autoUpdate), true)
  assert.equal(autoCheckFromSaved(false), false)
  assert.equal(autoCheckFromSaved(true), true)
})

test('通知文字：有新版本 x.y.z：說明第一行；沒說明就不加冒號；說明過長截斷', () => {
  assert.equal(updateNoticeText({ version: '0.1.9', notes: '\n  修好大頭貼\n第二行不顯示' }), '有新版本 0.1.9：修好大頭貼')
  assert.equal(updateNoticeText({ version: '0.1.9', notes: '' }), '有新版本 0.1.9')
  assert.equal(updateNoticeText({ version: '0.1.9' }), '有新版本 0.1.9')
  assert.equal(updateNoticeText(null), '')
  assert.equal(firstLine('字'.repeat(100)).length, 60)
  assert.ok(firstLine('字'.repeat(100)).endsWith('…'))
})

test('下載進度文字', () => {
  assert.equal(progressText(0, 1048576 * 10), '下載中 0%（0.0 / 10.0 MB）')
  assert.equal(progressText(1048576 * 5, 1048576 * 10), '下載中 50%（5.0 / 10.0 MB）')
  assert.equal(progressText(1048576 * 20, 1048576 * 10), '下載中 100%（20.0 / 10.0 MB）')
  assert.equal(progressText(1048576 * 3, null), '下載中 3.0 MB')
  assert.equal(progressText(NaN, null), '下載中…')
})

test('通知列狀態機：有新版 → 按更新 → 進度 → 失敗可重試；安裝中不被重新檢查蓋掉', () => {
  let st = initialUpdateState()
  assert.equal(st.phase, 'idle')
  const info = { version: '0.1.9', notes: 'x' }
  st = withAvailable(st, info)
  assert.equal(st.phase, 'available')
  assert.equal(withInstalling(initialUpdateState()).phase, 'idle', '沒有新版時按不出安裝中')
  st = withInstalling(st)
  assert.equal(st.phase, 'installing')
  st = withProgress(st, { done: 100, total: 400 })
  assert.deepEqual([st.done, st.total], [100, 400])
  assert.equal(withAvailable(st, null).phase, 'installing', '安裝中，重新檢查的結果不蓋掉')
  assert.equal(withProgress({ phase: 'available', info }, { done: 5 }).done, undefined, '不是安裝中就忽略進度')
  st = withFailure(st, '下載或驗簽失敗：signature mismatch')
  assert.equal(st.phase, 'failed')
  assert.match(st.error, /驗簽失敗/)
  assert.equal(st.info, info, '失敗後仍記得是哪一版，可重試')
  assert.equal(withInstalling(st).phase, 'installing')
  assert.equal(withAvailable(st, null).phase, 'idle', '失敗後重新檢查沒有新版就收起通知')
  assert.equal(withFailure(initialUpdateState(), '').error, '更新失敗')
})

test('立即檢查的結果文字', () => {
  assert.match(manualResultText({ version: '0.1.9' }, '0.1.8'), /有新版本 0\.1\.9（目前 0\.1\.8）/)
  assert.equal(manualResultText(null, '0.1.8'), '目前已是最新版（0.1.8）。')
})

test('latest.json：欄位、網址固定 https 且編碼、時間 RFC 3339', () => {
  const j = buildLatestJson({ version: '0.1.9', notes: '  修好了  ', pubDate: '2026-10-21T08:00:00Z', signature: 'c2ln\n' })
  assert.deepEqual(j, {
    version: '0.1.9',
    notes: '修好了',
    pub_date: '2026-10-21T08:00:00.000Z',
    platforms: { 'windows-x86_64': { signature: 'c2ln', url: 'https://asnmessenger.web.app/update/ASN_0.1.9_x64-setup.exe' } },
  })
  assert.equal(PLATFORM, 'windows-x86_64')
  assert.equal(installerName('0.1.9'), 'ASN_0.1.9_x64-setup.exe')
  assert.ok(installerUrl('0.1.9').startsWith('https://'))
  assert.throws(() => buildLatestJson({ version: '0.1', notes: '', pubDate: new Date(), signature: 'x' }), /版本號/)
  assert.throws(() => buildLatestJson({ version: '0.1.9', notes: '', pubDate: new Date(), signature: ' \n' }), /簽章/)
  assert.throws(() => buildLatestJson({ version: '0.1.9', notes: '', pubDate: 'nope', signature: 'x' }), /時間/)
})

test('更新說明：參數優先，其次 CHANGELOG 第一段，最後預設句', () => {
  const log = '# 變更紀錄\r\n\r\n## 0.1.9\r\n- 修好 A\r\n- 修好 B\r\n\r\n## 0.1.8\r\n- 舊的\r\n'
  assert.equal(changelogFirstSection(log), '- 修好 A\n- 修好 B')
  assert.equal(changelogFirstSection('沒有標題'), '')
  assert.equal(pickNotes({ arg: ' 手動說明 ', changelog: log, version: '0.1.9' }), '手動說明')
  assert.equal(pickNotes({ arg: '', changelog: log, version: '0.1.9' }), '- 修好 A\n- 修好 B')
  assert.equal(pickNotes({ arg: undefined, changelog: '', version: '0.1.9' }), 'ASN 0.1.9 更新')
})

test('發版參數', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, noBump: false, notes: '' })
  assert.deepEqual(parseArgs(['--dry-run', '--notes', '說明']), { dryRun: true, noBump: false, notes: '說明' })
  assert.equal(parseArgs(['--notes=甲']).notes, '甲')
  assert.equal(parseArgs(['--no-bump']).noBump, true)
  assert.throws(() => parseArgs(['--notes']), /說明文字/)
  assert.throws(() => parseArgs(['--bogus']), /不認得/)
})

test('接線：設定頁開關與立即檢查、存檔欄位、--shot 不檢查、Rust 指令註冊', () => {
  const html = read('ui/list.html'), panel = read('ui/lib/settings-panel.mjs'), js = read('ui/list.js'), rs = read('src-tauri/src/lib.rs'), up = read('src-tauri/src/updater.rs')
  assert.match(panel, /:checked="st\.autoCheck"[^>]*aria-label="自動檢查更新"/)   // 設定聊天窗的開關，改了經樞紐 applySetting 寫回 autoCheck
  assert.match(panel, /act\('check-update'\)"[^>]*>立即檢查</)
  assert.match(js, /case 'autoCheck': autoCheck\.value = value === true/)
  assert.match(js, /case 'check-update': await checkUpdate\(true\)/)
  assert.match(html, /@click\.stop="installUpdate"/, '只有按「更新」才安裝')
  assert.match(js, /autoUpdate: autoCheck\.value/, '開關存進 asn-me.json')
  assert.match(js, /if \(info\.shot \|\| upd\.checking/, '--shot 不檢查')
  assert.match(js, /if \(!info\.shot\) \{[\s\S]*?checkUpdate\(\)/, '啟動檢查只在非 --shot')
  assert.match(js, /setInterval\([^)]*CHECK_MS|CHECK_MS\)/)
  for (const cmd of ['update_check', 'update_install']) assert.match(rs, new RegExp(`updater::${cmd}`), cmd)
  assert.match(rs, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/)
  assert.match(up, /st\.shot\.is_some\(\)/, 'Rust 端也擋 --shot')
})

test('設定：公鑰在設定檔、來源固定 https、產 .sig；私鑰不在 repo、前端沒有外掛權限', () => {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'))
  const u = conf.plugins.updater
  assert.deepEqual(u.endpoints, ['https://asnmessenger.web.app/update/latest.json'])
  assert.equal(conf.bundle.createUpdaterArtifacts, true)
  assert.match(Buffer.from(u.pubkey, 'base64').toString('utf8'), /^untrusted comment: minisign public key/)
  assert.doesNotMatch(Buffer.from(u.pubkey, 'base64').toString('utf8'), /secret key/i)
  const cap = read('src-tauri/capabilities/default.json')
  assert.doesNotMatch(cap, /updater:/, '前端不直接用外掛指令，只走自訂命令')
  const cargo = read('src-tauri/Cargo.toml')
  assert.match(cargo, /tauri-plugin-updater = "=\d+\.\d+\.\d+"/, '版本固定')
  const ignore = fs.readFileSync(new URL('../../../.gitignore', import.meta.url), 'utf8')
  assert.match(ignore, /^\*\.key$/m)
  assert.match(ignore, /^site\/public\/update\/\*\.exe$/m)
  assert.match(ignore, /^site\/public\/update\/\*\.sig$/m)
  const rel = read('scripts/release.mjs')
  assert.match(rel, /TAURI_SIGNING_PRIVATE_KEY: keyFile/, "只傳私鑰檔案路徑")
  assert.doesNotMatch(rel, /readFileSync\(keyFile/, '腳本不讀私鑰內容')
  assert.doesNotMatch(rel, /console\.[a-z]+\([^)]*(PASSWORD|password)/, '不印密碼')
  assert.equal(JSON.parse(read('package.json')).scripts.release, 'node scripts/release.mjs')
})
