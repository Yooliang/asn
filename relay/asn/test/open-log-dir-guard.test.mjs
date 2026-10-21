import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('open_machine_log_dir：前端不能帶路徑參數', () => {
  const list = fs.readFileSync(path.join(root, 'ui/list.js'), 'utf8')
  assert.match(list, /invoke\('open_machine_log_dir'\)/)
  assert.doesNotMatch(list, /invoke\(\s*['"]open_machine_log_dir['"]\s*,/)
})

test('open_machine_log_dir：Tauri 指令簽名沒有路徑參數', () => {
  const lib = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8')
  assert.match(lib, /fn open_machine_log_dir\(app: State<'_, App>\)/)
  assert.doesNotMatch(lib, /fn open_machine_log_dir\([^)]*path/i)
})
