// 守門：Tauri 前端（ui/）不可 import 會拉進 Node 的 shared 模組（WebView ES module 載入會整頁失敗）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const uiRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (ent.name.endsWith('.mjs') || ent.name.endsWith('.js')) out.push(p)
  }
  return out
}

test('ui 腳本不 import relay/shared（含 launcher-profiles）', () => {
  const bad = []
  const reShared = /from\s+['"][^'"]*\/shared\/[^'"]+['"]/
  const reNode = /from\s+['"]node:[^'"]+['"]/
  for (const f of walk(uiRoot)) {
    const rel = path.relative(uiRoot, f)
    const text = fs.readFileSync(f, 'utf8')
    if (reShared.test(text)) bad.push(`${rel}: shared import`)
    if (reNode.test(text)) bad.push(`${rel}: node: import`)
  }
  assert.deepEqual(bad, [])
})
