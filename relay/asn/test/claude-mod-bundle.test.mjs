// Claude 外掛（relay/claude-mod）隨安裝包帶出去、版本跟著 ASN、設定頁有狀態行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createAccountsUi } from '../ui/lib/claude-accounts.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = f => fs.readFileSync(path.join(root, f), 'utf8')
const modDir = path.join(root, '..', 'claude-mod')

// 外掛資料夾裡「該帶走」的檔案：不含 .claude-plugin/types/ 與測試檔
function shippable(dir, rel = '') {
  const out = []
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) { if (r !== '.claude-plugin/types') out.push(...shippable(dir, r)) }
    else if (!/\.test\.[a-z]+$/.test(e.name)) out.push(r)
  }
  return out
}

test('打包：外掛每個該帶的檔案都列在 bundle.resources，且放在安裝資料夾的 claude-mod\\', () => {
  const res = JSON.parse(read('src-tauri/tauri.conf.json')).bundle.resources
  assert.ok(res && !Array.isArray(res), 'resources 要用「來源: 目標」的對照寫法，目標才是 claude-mod/…')
  const want = shippable(modDir)
  assert.ok(want.includes('.claude-plugin/plugin.json') && want.includes('.claude-plugin/marketplace.json') && want.includes('hooks/hooks.json'))
  for (const f of want) {
    assert.equal(res[`../../claude-mod/${f}`], `claude-mod/${f}`, `${f} 沒列進 bundle.resources（外掛新增檔案時要一起加）`)
  }
  for (const [src, dst] of Object.entries(res)) {
    assert.ok(fs.existsSync(path.join(root, 'src-tauri', src)), `resources 來源不存在：${src}`)
    assert.doesNotMatch(src, /\.test\.|\/types\//, '測試檔與 types 不帶')
    assert.ok(dst.startsWith('claude-mod/'))
  }
})

test('版本：外掛 plugin.json 的 version 與 ASN 版本一致', () => {
  const asn = JSON.parse(read('package.json')).version
  assert.equal(JSON.parse(fs.readFileSync(path.join(modDir, '.claude-plugin', 'plugin.json'), 'utf8')).version, asn)
})

test('發版：bump.mjs 會把 plugin.json 的 version 一起改（在暫存複本裡跑，不動真的檔）', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-bump-'))
  try {
    const a = path.join(t, 'relay', 'asn')
    fs.mkdirSync(path.join(a, 'scripts'), { recursive: true })
    fs.mkdirSync(path.join(a, 'src-tauri'), { recursive: true })
    fs.mkdirSync(path.join(t, 'relay', 'claude-mod', '.claude-plugin'), { recursive: true })
    fs.copyFileSync(path.join(root, 'scripts', 'bump.mjs'), path.join(a, 'scripts', 'bump.mjs'))
    fs.writeFileSync(path.join(a, 'package.json'), '{\n  "version": "1.2.3"\n}\n')
    fs.writeFileSync(path.join(a, 'src-tauri', 'tauri.conf.json'), '{\n  "version": "1.2.3"\n}\n')
    fs.writeFileSync(path.join(a, 'src-tauri', 'Cargo.toml'), '[package]\nversion = "1.2.3"\n')
    const pj = path.join(t, 'relay', 'claude-mod', '.claude-plugin', 'plugin.json')
    fs.writeFileSync(pj, '{\n  "name": "asn",\n  "version": "0.1.0",\n  "userConfig": {}\n}\n')
    const r = spawnSync(process.execPath, [path.join(a, 'scripts', 'bump.mjs')], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(fs.readFileSync(pj, 'utf8')).version, '1.2.4')
    assert.equal(JSON.parse(fs.readFileSync(path.join(a, 'package.json'), 'utf8')).version, '1.2.4')
    spawnSync(process.execPath, [path.join(a, 'scripts', 'bump.mjs'), 'minor'])
    assert.equal(JSON.parse(fs.readFileSync(pj, 'utf8')).version, '1.3.0')
  } finally { fs.rmSync(t, { recursive: true, force: true }) }
})

test('設定頁：狀態行由 claude_mod_status 帶進來、事件會更新、指令有註冊', async () => {
  const invoke = async cmd => { if (cmd === 'claude_mod_status') return 'Claude 外掛：已安裝'; if (cmd === 'claude_accounts_list') return []; return null }
  const ui = createAccountsUi({ invoke, reactive: o => o, sleep: async () => {} })
  assert.equal(ui.state.mod, '')
  await ui.refresh()
  assert.equal(ui.state.mod, 'Claude 外掛：已安裝')
  const old = createAccountsUi({ invoke: async cmd => { if (cmd === 'claude_mod_status') throw new Error('x'); return null }, reactive: o => o })
  await old.refresh()
  assert.equal(old.state.mod, '', '舊版 Rust 沒這個指令就不顯示')
  assert.match(read('ui/lib/settings-panel.mjs'), /v-if="st\.accounts\.mod"[^>]*>\{\{ st\.accounts\.mod \}\}/)
  assert.match(read('ui/list.js'), /listen\('claude-mod-status'/)
  assert.ok(read('src-tauri/src/lib.rs').includes('claude_mod::claude_mod_status'))
})
