// 守門：ASN Tauri 端不得再 spawn Node 或依賴 relay/machine 腳本路徑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rustRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'src')

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (ent.name.endsWith('.rs')) out.push(p)
  }
  return out
}

test('ASN Rust 不呼叫 node 或 machine/*.mjs', () => {
  const bad = []
  for (const f of walk(rustRoot)) {
    const rel = path.relative(rustRoot, f)
    const t = fs.readFileSync(f, 'utf8')
    if (/Command::new\(\s*"node"/.test(t)) bad.push(`${rel}: node spawn`)
    if (/local-partner-launch|partner-console\.mjs|relay_root|run_node_json/.test(t)) bad.push(`${rel}: machine/node 依賴`)
  }
  assert.deepEqual(bad, [])
})
