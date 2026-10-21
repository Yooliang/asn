import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('遠端開視窗的自動 profile 預設關：要 IRORI_LAUNCH_AUTO=1 才偵測本機 CLI', () => {
  const s = fs.readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8')
  assert.match(s, /const launchNoAuto = process\.env\.IRORI_LAUNCH_NO_AUTO === '1' \|\| process\.env\.IRORI_LAUNCH_AUTO !== '1'/)
})
