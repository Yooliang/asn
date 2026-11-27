// #2412：動態開背景夥伴（addPartnerWorker）要和 start() 共用同一份帳本，不能丟 ReferenceError。
// 用暫存資料夾與假的 agy 驅動，不碰真的 AI。
// 執行：node --test relay/machine/test/acp-add-partner.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../engines/acp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const FAKE_AGY = path.join(here, 'fake-agy.mjs')
const PASS = ['FAKE_AGY_STATE']
const DROP = ['USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'ASN_HOME', 'IRORI_HOME', 'ASN_CLAUDE_HOME', 'ASN_GROK_HOME']
const envWithoutHomes = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !DROP.includes(k.toUpperCase())))
const noop ={ onSent() {}, onFail() {}, onReply() {} }

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-acp-add-partner-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home)
  fs.mkdirSync(path.join(dir, 'st'))
  const file = path.join(dir, 'agents.json')
  const base = { name: 'Gemini', engine: 'acp', roster_engine: 'gemini', protocol: 'agy-stream', command: process.execPath, args: [FAKE_AGY], env_pass: PASS }
  fs.writeFileSync(file, JSON.stringify({ workers: [base] }))
  const logs = []
  const engine = createEngine({
    log: m => logs.push(m), workDir: dir, mailboxName: 'T-收發室',
    env: { ...envWithoutHomes(), USERPROFILE: home, HOME: home, IRORI_AGENTS_FILE: file, FAKE_AGY_STATE: path.join(dir, 'st') },
    send: async () => {}, deps: { realHome: home },
  })
  // 剛 start 就立刻 stop 會讓工作者的啟動程序殘留、測試行程不結束（另案），先等它啟動完
  const cleanup = async () => { await new Promise(r => setTimeout(r, 1500)); engine.stop(); await new Promise(r => setTimeout(r, 150)); try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
  return { dir, engine, logs, cleanup }
}

// 以設定檔裡那個工作者為樣板，換名字與資料夾，模擬 bridge 組出來的 spec
function specFrom(engine, dir, name) {
  const cfg = engine._workers.get('Gemini').cfg
  return { ...cfg, name, cwd: path.join(dir, 'partner-cwd', name) }
}

test('start 之後動態開夥伴：開得起來、名單看得到、不丟 ReferenceError', async () => {
  const { dir, engine, cleanup } = setup()
  try {
    engine.start(noop)
    engine.addPartnerWorker(specFrom(engine, dir, 'Partner甲'))
    assert.ok(engine._workers.has('Partner甲'))
    const names = (await engine.listWindows()).windows.map(w => w.name)
    assert.ok(names.includes('Partner甲'), `名單裡沒有新夥伴：${names}`)
  } finally { await cleanup() }
})

test('start 之前就動態開夥伴：不丟 ReferenceError（能用或白話錯誤）', async () => {
  const { dir, engine, cleanup } = setup()
  try {
    // 先借 start 取得樣板，再停掉重建一個還沒 start 的引擎的情形用同一個 cfg
    engine.start(noop)
    const spec = specFrom(engine, dir, 'Partner乙')
    await new Promise(r => setTimeout(r, 1500))
    engine.stop()
    const fresh = createEngine({
      log: () => {}, workDir: dir, mailboxName: 'T-收發室',
      env: { ...envWithoutHomes(), USERPROFILE: path.join(dir, 'home'), HOME: path.join(dir, 'home'), IRORI_AGENTS_FILE: path.join(dir, 'nope.json'), FAKE_AGY_STATE: path.join(dir, 'st') }, send: async () => {}, deps: { realHome: path.join(dir, 'home') },
    })
    try {
      fresh.addPartnerWorker(spec)
      assert.ok(fresh._workers.has('Partner乙'))
    } catch (e) {
      assert.ok(!(e instanceof ReferenceError), `不該是 ReferenceError：${e.message}`)
    } finally { await new Promise(r => setTimeout(r, 1500)); fresh.stop() }
  } finally { await cleanup() }
})

test('動態開的夥伴與 start 開的共用同一份帳本檔', async () => {
  const { dir, engine, cleanup } = setup()
  try {
    engine.start(noop)
    engine.addPartnerWorker(specFrom(engine, dir, 'Partner丙'))
    assert.ok(engine._workers.has('Gemini') && engine._workers.has('Partner丙'))
    // 帳本檔只應有一個，且路徑在 workDir
    assert.ok(!fs.existsSync(path.join(dir, 'acp-workers.json.bad')))
  } finally { await cleanup() }
})
