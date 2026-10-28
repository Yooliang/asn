// 0.2 H2：名單回報帶平台；launcher.json 寫 {"remote_launch": false, "reason": "…"} 時這台不開放，原因只留純文字
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CLOSED_REASON_MAX, closedFromJson, loadConfig, platformOf, readClosed } from '../launcher.mjs'

test('平台只回固定幾個值', () => {
  assert.equal(platformOf('linux'), 'linux')
  assert.equal(platformOf('win32'), 'windows')
  assert.equal(platformOf('darwin'), 'macos')
  for (const p of ['aix', 'freebsd', '', undefined]) assert.equal(platformOf(p ?? 'x'), null)
})

test('remote_launch:false：不開放；原因去控制字元、最多 120 字，HTML 標籤照原樣當文字（顯示端用文字插值）', () => {
  assert.deepEqual(closedFromJson({ remote_launch: false, reason: ' 測試用伺服器\n不開放\u0007 ' }), { closed: true, reason: '測試用伺服器 不開放' })
  assert.deepEqual(closedFromJson({ remote_launch: false }), { closed: true, reason: null })
  assert.equal([...closedFromJson({ remote_launch: false, reason: '字'.repeat(300) }).reason].length, CLOSED_REASON_MAX)
  assert.equal(closedFromJson({ remote_launch: false, reason: '<b>x</b>' }).reason, '<b>x</b>')
  for (const j of [null, {}, { remote_launch: true }, { remote_launch: 'false' }]) assert.deepEqual(closedFromJson(j), { closed: false })
})

test('寫了 remote_launch:false 就不載入任何 profile（連自動偵測的都不用）；檔案讀不到或壞掉都當沒寫', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-closed-'))
  const f = path.join(d, 'launcher.json')
  fs.writeFileSync(f, JSON.stringify({ remote_launch: false, reason: '測試用伺服器，不開放', profiles: { a: { command: 'x', args: [] } }, cwd_allow: [d] }))
  const boot = { profiles: { claude: { command: 'claude', args: [] } }, cwd_allow: [d], max_per_hour: 6 }
  const r = loadConfig(f, boot)
  assert.equal(r.config, null)
  assert.match(r.error, /remote_launch:false/)
  assert.deepEqual(readClosed(f), { closed: true, reason: '測試用伺服器，不開放' })
  assert.deepEqual(readClosed(path.join(d, '沒有.json')), { closed: false })
  fs.writeFileSync(f, '{壞')
  assert.deepEqual(readClosed(f), { closed: false })
})

test('接線：名單回報帶 platform 與 launch_closed_reason', () => {
  const src = fs.readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8')
  assert.match(src, /platform: platformOf\(\), launch_closed_reason: closed\.closed \? closed\.reason : null/)
})
