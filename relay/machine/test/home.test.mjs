// 使用者資料夾單一解析函式（home.mjs）守門（ONBOARDING §5.2，#14 R2）。全部在暫存資料夾與注入的 base／env 裡做，
// 不碰真的 ~/.asn、~/.irori-relay；金鑰是假內容。與 Rust 端 relay/asn/src-tauri/src/home.rs 的解析規則一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { locateIn, resolveHome } from '../home.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const MACHINE = path.join(here, '..')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asn-home-test-'))
const put = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body) }
const legacyOf = base => path.join(base, '.irori-relay')
const newOf = base => path.join(base, '.asn')

test('全新電腦：用 ~/.asn，而且解析不會建任何東西', () => {
  const b = tmp()
  const h = resolveHome({ base: b, env: {} })
  assert.deepEqual([h.state, h.primary, h.fallback], ['fresh', newOf(b), null])
  assert.equal(fs.existsSync(newOf(b)), false)
})

test('只有舊的 → 用舊的；只有新的 → 用新的', () => {
  const b = tmp(); put(path.join(legacyOf(b), 'H.key'), 'fake')
  assert.deepEqual([resolveHome({ base: b, env: {} }).state, resolveHome({ base: b, env: {} }).primary], ['legacy', legacyOf(b)])
  const c = tmp(); put(path.join(newOf(c), 'handoff', 'a.md'), 'x')
  assert.equal(resolveHome({ base: c, env: {} }).state, 'new')
})

test('兩邊都有且舊的有內容（尚未遷移）→ 用舊的、新的當後備；locateIn 會回頭找後備', () => {
  const b = tmp()
  put(path.join(legacyOf(b), 'node'), 'H')
  put(path.join(newOf(b), 'H.key'), 'fake')
  const h = resolveHome({ base: b, env: {} })
  assert.deepEqual([h.state, h.primary, h.fallback], ['pending', legacyOf(b), newOf(b)])
  assert.equal(locateIn(h, 'node'), path.join(legacyOf(b), 'node'))
  assert.equal(locateIn(h, 'H.key'), path.join(newOf(b), 'H.key'), '主要位置沒有就回頭找後備')
  assert.equal(locateIn(h, 'nothing'), path.join(legacyOf(b), 'nothing'), '都沒有回主要位置（給寫入用）')
})

test('舊的是連結（遷移完成）或空資料夾 → 用新的', () => {
  const b = tmp(); put(path.join(newOf(b), 'H.key'), 'fake')
  fs.symlinkSync(newOf(b), legacyOf(b), 'junction')
  const h = resolveHome({ base: b, env: {} })
  assert.deepEqual([h.state, h.primary], ['linked', newOf(b)])
  assert.equal(fs.readFileSync(path.join(legacyOf(b), 'H.key'), 'utf8'), 'fake', '舊路徑經連結仍讀得到')
  const c = tmp(); fs.mkdirSync(legacyOf(c)); fs.mkdirSync(newOf(c))
  assert.equal(resolveHome({ base: c, env: {} }).state, 'new')
})

test('ASN_HOME 覆寫（舊名 IRORI_HOME 也認，新名優先），不看舊位置', () => {
  const b = tmp(); put(path.join(legacyOf(b), 'node'), 'H')
  const x = path.join(b, 'custom')
  const h = resolveHome({ base: b, env: { ASN_HOME: x } })
  assert.deepEqual([h.state, h.primary, h.fallback], ['override', path.resolve(x), null])
  assert.equal(resolveHome({ base: b, env: { IRORI_HOME: x } }).primary, path.resolve(x))
  assert.equal(resolveHome({ base: b, env: { ASN_HOME: x, IRORI_HOME: path.join(b, 'other') } }).primary, path.resolve(x))
  assert.equal(resolveHome({ base: b, env: { ASN_HOME: '  ' } }).state, 'legacy', '空白不算覆寫')
})

test('各程式真的走這個解析：子行程在暫存家目錄裡，identity 的 HOME_DIR 與讀金鑰都跟著解析結果', () => {
  const run = (b, extraEnv = {}) => {
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: b, USERPROFILE: b, ...extraEnv }
    const code = "import('" + path.join(MACHINE, 'identity.mjs').replace(/\\/g, '/').replace(/^/, 'file:///') + "').then(m=>{process.stdout.write(JSON.stringify({dir:m.HOME_DIR,node:m.machineNode(),key:m.readMachineKey('H')}))})"
    const r = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8', windowsHide: true })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout)
  }
  const a = tmp(); put(path.join(legacyOf(a), 'node'), 'H'); put(path.join(legacyOf(a), 'H.key'), 'fake-legacy')
  assert.deepEqual(run(a), { dir: legacyOf(a), node: 'H', key: 'fake-legacy' })
  const b = tmp(); put(path.join(newOf(b), 'node'), 'H'); put(path.join(newOf(b), 'H.key'), 'fake-new')
  assert.deepEqual(run(b), { dir: newOf(b), node: 'H', key: 'fake-new' })
  const c = tmp(); put(path.join(c, 'custom', 'node'), 'H'); put(path.join(c, 'custom', 'H.key'), 'fake-env'); put(path.join(legacyOf(c), 'H.key'), 'x')
  assert.deepEqual(run(c, { ASN_HOME: path.join(c, 'custom') }), { dir: path.join(c, 'custom'), node: 'H', key: 'fake-env' })
  // 兩邊都有（尚未遷移）、金鑰只在新位置：回頭找後備
  const d = tmp(); put(path.join(legacyOf(d), 'node'), 'H'); put(path.join(newOf(d), 'H.key'), 'fake-fallback')
  assert.deepEqual(run(d), { dir: legacyOf(d), node: 'H', key: 'fake-fallback' })
})

test('守門：資料夾名只在 home.mjs 出現一次；其他程式一律經單一解析函式（不得再寫死 .irori-relay）', () => {
  const root = path.join(MACHINE, '..')
  const offenders = []
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'test' || e.name === 'target') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (['machine', 'cloud-agent', 'shared'].includes(path.relative(root, p).split(path.sep)[0])) walk(p); continue }
      if (!/\.mjs$/.test(e.name) || e.name === 'home.mjs') continue
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '')   // 註解不算
        if (/['"`][^'"`]*\.irori-relay/.test(code) || /\birori-relay['"`]/.test(code)) offenders.push(`${path.relative(root, p)}:${i + 1}`)
      })
    }
  }
  for (const top of ['machine', 'cloud-agent', 'shared']) walk(path.join(root, top))
  assert.deepEqual(offenders, [], '這些地方還寫死舊資料夾名')
})
