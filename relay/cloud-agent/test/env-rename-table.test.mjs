// 環境變數改名相容守門（#14 第一期）：對照表裡每一個名字都要證明「只設舊名行、只設新名行、兩個都設以新名為準」，
// 而且程式與 shell 腳本裡出現的每個 IRORI_ 名字都要在對照表裡（不能有人偷偷新增一個只認舊名的變數）。
// 只用假環境物件與原始碼掃描，不碰任何真實設定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyEnvCompat, ENV_RENAME_PAIRS, SCRUB_ENV_PREFIXES, withoutRelayEnv } from '../env-compat.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('對照表每一項：只設舊名、只設新名、兩個都設以新名為準', () => {
  for (const [n, o] of ENV_RENAME_PAIRS) {
    assert.equal(applyEnvCompat({ [o]: 'old' }).env[n], 'old', `${n} 只設舊名`)
    assert.equal(applyEnvCompat({ [n]: 'new' }).env[n], 'new', `${n} 只設新名`)
    const both = applyEnvCompat({ [n]: 'new', [o]: 'old' })
    assert.equal(both.env[n], 'new', `${n} 兩個都設`)
    assert.deepEqual(both.conflictNames, [n])
    assert.equal(applyEnvCompat({ [n]: '  ', [o]: 'old' }).env[n], 'old', `${n} 新名空白退回舊名`)
  }
})

test('金鑰類新舊名都會被子程序環境清理剝掉', () => {
  const out = withoutRelayEnv({ PATH: '/bin', ASN_RELAY_KEY: 'a', IRORI_RELAY_KEY: 'b', ASN_RELAY_ANON_KEY: 'c', IRORI_RELAY_ANON_KEY: 'd' })
  assert.deepEqual(Object.keys(out), ['PATH'])
  assert.ok(SCRUB_ENV_PREFIXES.includes('IRORI_') && SCRUB_ENV_PREFIXES.includes('ASN_'))
})

test('守門：程式與腳本裡出現的 IRORI_ 名字都在對照表（或明確列為不改名）', () => {
  const known = new Set(ENV_RENAME_PAIRS.map(p => p[1]))
  const NOT_RENAMED = [/^IRORI_WAKE_/, /^IRORI_CLOUD_AGENTS_DIR$/]   // 平台叫醒用的設定，不屬這一期
  const unknown = []
  for (const f of fs.readdirSync(ROOT)) {
    if (!/\.(mjs|sh)$/.test(f) || f === 'env-compat.mjs') continue
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
    for (const line of src.split('\n')) {
      if (/^\s*(\/\/|#)/.test(line)) continue
      for (const m of line.matchAll(/IRORI_[A-Z0-9_]+/g)) {
        if (!known.has(m[0]) && !NOT_RENAMED.some(r => r.test(m[0]))) unknown.push(`${f}:${m[0]}`)
      }
    }
  }
  assert.deepEqual(unknown, [], '這些舊名沒有登記在 ENV_RENAME_PAIRS（只認舊名的變數不能新增）')
})
