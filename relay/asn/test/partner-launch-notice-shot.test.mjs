// --shot 掛勾：彈出「背景逾時改前台」通知並截圖（Linux 需 scrot＋Xvfb，由 run-tests.mjs 提供 DISPLAY）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { defaultExe, runShot, shotCaptureSupported } from '../scripts/shot.mjs'
import { assertShotNotBlank } from './shot-png.mjs'

const ART_DIR = '/opt/cursor/artifacts/screenshots'
const SHOT_FILE = 'tabs-launch-notice.png'
const READY_MARK = 'launch-notice-ready.ok'

test('shot：背景逾時改前台通知對話框', {
  skip: (!fs.existsSync(defaultExe) && '先執行 npm run build') || (!shotCaptureSupported && '此平台不支援 --shot 截圖'),
  timeout: 120_000,
}, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-launch-notice-'))
  const r = await runShot(out, defaultExe, { me: { shotLaunchNotice: true }, timeoutMs: 60_000 })
  assert.equal(r.code, 0, r.log)
  assert.ok(r.files.includes(SHOT_FILE), `缺 ${SHOT_FILE}：${r.files.join(', ')}`)
  assert.ok(r.files.includes(READY_MARK), `前端未回報對話框就緒（缺 ${READY_MARK}）`)
  const png = path.join(out, SHOT_FILE)
  assertShotNotBlank(png)
  fs.mkdirSync(ART_DIR, { recursive: true })
  const dest = path.join(ART_DIR, 'partner-launch-background-notice.png')
  fs.copyFileSync(png, dest)
})
