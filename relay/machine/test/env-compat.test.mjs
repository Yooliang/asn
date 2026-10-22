// 環境變數改名相容守門（ONBOARDING §5.2，第一期）：IRORI_<名> → ASN_<名>。
// 每個改名都要證明：只設舊名行、只設新名行、兩個都設以新名為準；子程序環境新舊名都帶、金鑰新舊名都擋。
// 全部用假環境物件與 127.0.0.1／暫存資料夾，不碰真的 ~/.irori-relay、~/.asn。
// 執行：node --test relay/machine/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RENAMED, SECRET_NAMES, envGet, isSecretEnvName, withBothNames } from '../env-compat.mjs'
import { childEnv } from '../launcher.mjs'
import { codexChildEnv, resolveCodex } from '../engines/codex-bin.mjs'
import { parsePullBackoffMs } from '../pull-retry.mjs'
import { loadEngines } from '../engines/index.mjs'
import { machineNode, readMachineKey } from '../identity.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const MACHINE = path.join(here, '..')

// ---- 三態：只舊、只新、兩個都有（新名為準）

test('envGet：只設舊名也行、只設新名也行、兩個都設以新名為準、新名是空字串時退回舊名', () => {
  assert.equal(envGet({ IRORI_RELAY_URL: 'old' }, 'RELAY_URL'), 'old')
  assert.equal(envGet({ ASN_RELAY_URL: 'new' }, 'RELAY_URL'), 'new')
  assert.equal(envGet({ ASN_RELAY_URL: 'new', IRORI_RELAY_URL: 'old' }, 'RELAY_URL'), 'new')
  assert.equal(envGet({ ASN_RELAY_URL: '  ', IRORI_RELAY_URL: 'old' }, 'RELAY_URL'), 'old')
  assert.equal(envGet({}, 'RELAY_URL'), undefined)
})

test('每個已改名的變數：三態都對（逐一跑 RENAMED 清單）', () => {
  for (const n of RENAMED) {
    assert.equal(envGet({ [`IRORI_${n}`]: 'o' }, n), 'o', `${n} 只設舊名`)
    assert.equal(envGet({ [`ASN_${n}`]: 'x' }, n), 'x', `${n} 只設新名`)
    assert.equal(envGet({ [`ASN_${n}`]: 'x', [`IRORI_${n}`]: 'o' }, n), 'x', `${n} 兩個都設`)
  }
})

test('identity：節點代號與金鑰，只舊名／只新名／兩個都設（新名為準）', () => {
  const keep = { id: process.env.ASN_RELAY_ID, oid: process.env.IRORI_RELAY_ID, key: process.env.ASN_RELAY_KEY, okey: process.env.IRORI_RELAY_KEY }
  const set = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try {
    set('ASN_RELAY_ID', undefined); set('IRORI_RELAY_ID', 'OLD')
    assert.equal(machineNode(), 'OLD')
    set('ASN_RELAY_ID', 'NEW'); set('IRORI_RELAY_ID', undefined)
    assert.equal(machineNode(), 'NEW')
    set('IRORI_RELAY_ID', 'OLD')
    assert.equal(machineNode(), 'NEW')

    set('ASN_RELAY_KEY', undefined); set('IRORI_RELAY_KEY', 'old-key')
    assert.equal(readMachineKey('X'), 'old-key')
    set('ASN_RELAY_KEY', 'new-key'); set('IRORI_RELAY_KEY', undefined)
    assert.equal(readMachineKey('X'), 'new-key')
    set('IRORI_RELAY_KEY', 'old-key')
    assert.equal(readMachineKey('X'), 'new-key')
  } finally {
    set('ASN_RELAY_ID', keep.id); set('IRORI_RELAY_ID', keep.oid); set('ASN_RELAY_KEY', keep.key); set('IRORI_RELAY_KEY', keep.okey)
  }
})

test('identity BASE_URL（匯入時決定）：只舊名／只新名／兩個都設以新名為準', () => {
  const id = pathToFileURL(path.join(MACHINE, 'identity.mjs')).href
  const urlIn = env => {
    const e = { ...process.env }; delete e.IRORI_RELAY_URL; delete e.ASN_RELAY_URL; Object.assign(e, env)
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import('${id}').then(m => console.log(m.BASE_URL))`], { env: e, encoding: 'utf8' })
    return r.stdout.trim()
  }
  assert.equal(urlIn({ IRORI_RELAY_URL: 'http://127.0.0.1:9/old/' }), 'http://127.0.0.1:9/old')
  assert.equal(urlIn({ ASN_RELAY_URL: 'http://127.0.0.1:9/new/' }), 'http://127.0.0.1:9/new')
  assert.equal(urlIn({ ASN_RELAY_URL: 'http://127.0.0.1:9/new', IRORI_RELAY_URL: 'http://127.0.0.1:9/old' }), 'http://127.0.0.1:9/new')
})

test('引擎與退避：ENGINES、CODEX_SCRIPT／CODEX_BIN、PULL_BACKOFF_MS 三態', async () => {
  const fakeEngine = path.join(here, 'fake-engine.mjs')
  const ctx = { log() {}, workDir: path.join(here, '..'), env: {} }
  const idOf = async env => (await loadEngines(ctx, envGet(env, 'ENGINES') || 'claude')).map(e => e.id).join(',')
  const oldRes = await idOf({ IRORI_ENGINES: fakeEngine })
  const newRes = await idOf({ ASN_ENGINES: fakeEngine })
  assert.equal(newRes, oldRes)
  assert.notEqual(newRes, await idOf({}))   // 沒設＝預設 claude，確實不同
  assert.equal(await idOf({ ASN_ENGINES: fakeEngine, IRORI_ENGINES: 'claude' }), newRes)

  assert.deepEqual(resolveCodex({ IRORI_CODEX_BIN: '/o' }).command, '/o')
  assert.deepEqual(resolveCodex({ ASN_CODEX_BIN: '/n' }).command, '/n')
  assert.deepEqual(resolveCodex({ ASN_CODEX_BIN: '/n', IRORI_CODEX_BIN: '/o' }).command, '/n')
  assert.deepEqual(resolveCodex({ IRORI_CODEX_SCRIPT: 'o.mjs' }).pre, ['o.mjs'])
  assert.deepEqual(resolveCodex({ ASN_CODEX_SCRIPT: 'n.mjs', IRORI_CODEX_SCRIPT: 'o.mjs' }).pre, ['n.mjs'])

  assert.deepEqual(parsePullBackoffMs({ IRORI_PULL_BACKOFF_MS: '5,10' }), [5, 10])
  assert.deepEqual(parsePullBackoffMs({ ASN_PULL_BACKOFF_MS: '7' }), [7])
  assert.deepEqual(parsePullBackoffMs({ ASN_PULL_BACKOFF_MS: '7', IRORI_PULL_BACKOFF_MS: '5,10' }), [7])
})

// ---- 子程序環境

test('子程序環境：金鑰新舊名都擋；非金鑰的改名變數新舊名都帶；只設一邊也補另一邊', () => {
  const base = { PATH: 'p', ASN_RELAY_KEY: 'k1', IRORI_RELAY_KEY: 'k2', ASN_RELAY_ANON_KEY: 'a1', IRORI_RELAY_ANON_KEY: 'a2' }
  for (const f of [childEnv, codexChildEnv]) {
    const out = f({ ...base, ASN_RELAY_ID: 'N' })
    for (const k of SECRET_NAMES) assert.equal(out[k], undefined, `${f.name} 不該帶 ${k}`)
    assert.equal(out.ASN_RELAY_ID, 'N')
    assert.equal(out.IRORI_RELAY_ID, 'N')
    const o2 = f({ ...base, IRORI_RELAY_URL: 'u' })
    assert.equal(o2.ASN_RELAY_URL, 'u')
    assert.equal(o2.IRORI_RELAY_URL, 'u')
  }
  assert.ok(isSecretEnvName('asn_relay_key') && isSecretEnvName('IRORI_RELAY_ANON_KEY') && !isSecretEnvName('ASN_RELAY_ID'))
  const both = withBothNames({ ASN_RELAY_ID: 'new', IRORI_RELAY_ID: 'old' })
  assert.equal(both.IRORI_RELAY_ID, 'new', '兩個都設且不同時，兩個名字都給新名的值')
})

// ---- 原始碼守門

function sources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'test', 'installer'].includes(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sources(p, out)
    else if (e.name.endsWith('.mjs')) out.push(p)
  }
  return out
}
// env-compat 本身要寫舊名。Aegis 轉接橋專用的 IRORI_AEGIS_* 依 D11 將移出本 repo，第一期不改名（共用的 RELAY_* 已走 envGet）
const EXEMPT = new Set(['env-compat.mjs'])

test('守門：relay/machine 的程式不再直接讀 IRORI_*，一律走 envGet；envGet 的名字都在 RENAMED 清單', () => {
  const bad = [], unknown = []
  for (const f of sources(MACHINE)) {
    if (EXEMPT.has(path.basename(f))) continue
    const src = fs.readFileSync(f, 'utf8')
    const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
    if (/\benv(?:\.|\[\s*['"`])IRORI_(?!AEGIS_)/.test(code) || /\$env:IRORI_(?!FILE|ARGS|DIR|STYLE)/.test(code)) bad.push(path.relative(MACHINE, f))
    for (const m of code.matchAll(/envGet\(\s*[\w.]+\s*,\s*'([A-Z0-9_]+)'\s*\)/g)) if (!RENAMED.includes(m[1])) unknown.push(`${path.relative(MACHINE, f)}:${m[1]}`)
  }
  assert.deepEqual(bad, [], '這些檔案還在直接讀 IRORI_*（改用 envGet）')
  assert.deepEqual(unknown, [], '這些名字沒登記在 RENAMED（相容層與子程序補名會漏掉）')
})

test('守門：relay/machine 的檔案一律 LF（會在 Linux 上跑）', () => {
  const crlf = sources(MACHINE).filter(f => fs.readFileSync(f, 'utf8').includes('\r')).map(f => path.relative(MACHINE, f))
  assert.deepEqual(crlf, [])
})
