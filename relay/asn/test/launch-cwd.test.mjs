// 開新夥伴的「工作資料夾」下拉：前端合併邏輯、Rust 指令接線、對話框截圖（有建置才跑）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { CWD_EMPTY_HINT, CWD_MAX, mergeCwdLists, withPickedCwd } from '../ui/lib/launch-prefs.mjs'
import { defaultExe, runShot, shotCaptureSupported } from '../scripts/shot.mjs'
import { assertShotNotBlank } from './shot-png.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = f => fs.readFileSync(path.join(root, f), 'utf8')

test('合併：依先後、去重、空白與空字串略過', () => {
  assert.deepEqual(mergeCwdLists([['/a', ' ', ''], ['/b', '/a'], null]), ['/a', '/b'])
})

test('合併：Windows 的 / 與 \\、大小寫、尾端分隔線算同一個', () => {
  assert.deepEqual(mergeCwdLists([['D:\\Github\\x'], ['D:/Github/x', 'd:\\github\\x\\'], ['D:/y/']]), ['D:\\Github\\x', 'D:/y/'])
  // 非 Windows 路徑大小寫不同就是不同資料夾
  assert.deepEqual(mergeCwdLists([['/Home/A', '/home/a']]), ['/Home/A', '/home/a'])
})

test('合併：最多 15 筆', () => {
  const many = Array.from({ length: 40 }, (_, i) => `/p${i}`)
  assert.equal(CWD_MAX, 15)
  assert.deepEqual(mergeCwdLists([many]), many.slice(0, 15))
})

test('瀏覽選到的資料夾：放最前面、已在清單裡就移到最前、取消（空）不變', () => {
  assert.deepEqual(withPickedCwd(['/a', '/b'], '/c'), ['/c', '/a', '/b'])
  assert.deepEqual(withPickedCwd(['/a', '/b'], '/b'), ['/b', '/a'])
  assert.deepEqual(withPickedCwd(['/a'], null), ['/a'])
  assert.deepEqual(withPickedCwd([], 'D:\\x'), ['D:\\x'])
})

test('空清單的提示字與接線：下拉旁有瀏覽鈕、空時顯示提示、Rust 指令都有註冊', () => {
  assert.match(CWD_EMPTY_HINT, /瀏覽/)
  const html = read('ui/list.html')
  assert.match(html, /@click\.prevent="browsePartnerCwd"[^>]*aria-label="瀏覽資料夾"/)
  assert.match(html, /v-if="!partnerCwdChoices\.length"/)
  const lib = read('src-tauri/src/lib.rs')
  const used = [...read('ui/lib/tauri.mjs').matchAll(/invoke\('(launch_cwd_[a-z_]+)'/g)].map(m => m[1]).sort()
  assert.deepEqual(used, ['launch_cwd_browse', 'launch_cwd_candidates'])
  for (const c of used) assert.ok(new RegExp(`async fn ${c}\\b`).test(lib) && lib.includes(`${c},`), `${c} 沒註冊`)
})

test('遠端啟動不因本機同意而擴大：同意只寫 launch-prefs.json，Rust 端不改 launcher.json', () => {
  const cwds = read('src-tauri/src/launch/cwds.rs').split('#[cfg(test)]')[0]
  assert.doesNotMatch(cwds, /launcher_config_path|launcher\.json"\)/)
  // 放行邏輯只掛在本機啟動；遠端的 relay_launch 不經過它
  assert.match(read('src-tauri/src/launch/local.rs'), /grant_local_cwd/)
  assert.doesNotMatch(read('src-tauri/src/launch/mod.rs'), /grant_local_cwd/)
})

test('shot：開新夥伴對話框（候選來自暫存家目錄裡假的 Claude 視窗與信任資料夾）', {
  skip: (!fs.existsSync(defaultExe) && '先執行 npm run build') || (!shotCaptureSupported && '此平台不支援 --shot 截圖'),
  timeout: 120_000,
}, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-partner-dlg-'))
  const r = await runShot(out, defaultExe, {
    me: { shotPartnerDlg: true },
    timeoutMs: 60_000,
    setup: env => {
      const home = env.USERPROFILE
      const mk = n => { const p = path.join(home, n); fs.mkdirSync(p, { recursive: true }); return p }
      const open = mk('Work\\asn'), trusted = mk('Work\\irori')
      fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true })
      fs.writeFileSync(path.join(home, '.claude', 'sessions', '1.json'), JSON.stringify({ cwd: open }))
      fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: {
        [trusted]: { hasTrustDialogAccepted: true }, [trusted.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true },
        [path.join(home, 'gone')]: { hasTrustDialogAccepted: true },
      } }))
    },
  })
  assert.equal(r.code, 0, r.log)
  assert.ok(r.files.includes('tabs-partner-dlg.png'), r.files.join(', '))
  assertShotNotBlank(path.join(out, 'tabs-partner-dlg.png'))
  console.log('SHOT_DIR', out)
})

test('背景／前台切換：前端讀的欄位名要跟 Rust 回傳一致（can_toggle）', async () => {
  const fs = await import('node:fs')
  const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  const rs = fs.readFileSync(new URL('../src-tauri/src/launch/console.rs', import.meta.url), 'utf8')
  assert.ok(rs.includes('can_toggle: Option<bool>'))
  assert.match(js, /q\?\.can_toggle/)
})
