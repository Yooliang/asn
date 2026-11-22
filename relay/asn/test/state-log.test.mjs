// 狀態變動記錄（#2104 B）：AI 工具版本與登入、偵測結果、Claude 外掛、工作資料夾
// 每一項：初始記一行、值沒變不記、值變了記一行；另外鎖住 list.js 真的有接上、而且寫進 ui.log 的管道（console.info）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { LOG_HEAD, createStateLog } from '../ui/lib/state-log.mjs'
import { installUiLog } from '../ui/lib/ui-log.mjs'

const mk = () => { const lines = []; return { lines, log: createStateLog(t => lines.push(t)) } }
const row = (o = {}) => ({ id: 'claude', installed: true, version: '1.2.3', version_state: 'latest', latest: '1.2.3', login: 'in', login_count: 1, ...o })

test('ai-cli：第一次記初始、沒變不記、值變了記一行', () => {
  const { lines, log } = mk()
  log.aiCliStatus([row(), row({ id: 'codex', version: '0.5', login: 'out' })])
  assert.equal(lines.length, 1)
  assert.equal(lines[0], 'ai-cli 初始：claude 版本=1.2.3 最新=latest 登入=in；codex 版本=0.5 最新=latest 登入=out')
  log.aiCliStatus([row(), row({ id: 'codex', version: '0.5', login: 'out' })])
  assert.equal(lines.length, 1, '值沒變不記')
  log.aiCliStatus([row({ version: '1.2.4', version_state: 'behind', latest: '1.3.0' }), row({ id: 'codex', version: '0.5', login: 'out' })])
  assert.equal(lines.length, 2)
  assert.equal(lines[1], 'ai-cli 變動：claude 版本 1.2.3→1.2.4；claude 最新 latest→behind(1.3.0)')
  log.aiCliStatus([row({ version: '1.2.4', version_state: 'behind', latest: '1.3.0' }), row({ id: 'codex', version: '0.5', login: 'in' })])
  assert.equal(lines[2], 'ai-cli 變動：codex 登入 out→in')
})

test('ai-cli：不記帳號、憑證；只寫固定欄位', () => {
  const { lines, log } = mk()
  log.aiCliStatus([row({ email: 'a@b.com', token: 'sk-secret', login_count: 3 })])
  assert.ok(!/a@b\.com|sk-secret/.test(lines.join('\n')))
  assert.match(lines[0], /登入=in\(3\)/)
})

test('ai-cli-detect：初始、沒變不記、變了記一行', () => {
  const { lines, log } = mk()
  const d = (found, v = '') => [{ id: 'claude', binary_found: true, version: '1.0' }, { id: 'codex', binary_found: found, version: v }]
  log.aiCliDetect(d(false))
  assert.equal(lines[0], LOG_HEAD.detectInit + 'claude 已安裝 1.0；codex 未安裝')
  log.aiCliDetect(d(false))
  assert.equal(lines.length, 1)
  log.aiCliDetect(d(true, '0.9'))
  assert.equal(lines.length, 2)
  assert.equal(lines[1], LOG_HEAD.detectChange + 'codex 未安裝→已安裝 0.9')
})

test('外掛：初始、沒變不記、變了記一行；null 不記', () => {
  const { lines, log } = mk()
  log.claudeMod(null)
  assert.equal(lines.length, 0)
  log.claudeMod({ state: 'checking' })
  assert.deepEqual(lines, ['外掛 初始：checking'])
  log.claudeMod({ state: 'checking' })
  assert.equal(lines.length, 1)
  log.claudeMod({ state: 'installed', version: '0.2.63' })
  assert.equal(lines[1], '外掛 變動：checking→installed 0.2.63')
  log.claudeMod({ state: 'failed', reason: '找不到 claude\n指令' })
  assert.equal(lines[2], '外掛 變動：installed 0.2.63→failed 原因：找不到 claude 指令')
})

test('資料夾：加入、移除各記一行；Rust 端拒絕的原因也記', () => {
  const { lines, log } = mk()
  log.cwdAdded('D:\\work\\a')
  log.cwdRemoved('D:\\work\\a')
  log.cwdRejected('加入', '這個資料夾不存在')
  assert.deepEqual(lines, ['資料夾 加入：D:\\work\\a', '資料夾 移除：D:\\work\\a', '資料夾 拒絕：加入 這個資料夾不存在'])
})

test('管道：用 console.info 帶 [ASN] 就會進 ui.log 佇列（console.log 不會）', async () => {
  const sent = []
  const target = { info() {}, warn() {}, error() {}, log() {} }
  installUiLog({ invoke: async (c, a) => sent.push(...a.lines), target, setTimer: fn => { sent.timer = fn }, now: () => new Date('2026-11-22T00:00:00Z') })
  const log = createStateLog(t => target.info('[ASN]', t))
  log.cwdAdded('X')
  await sent.timer()
  assert.equal(sent.length, 1)
  assert.match(sent[0], /info \[ASN\] 資料夾 加入：X$/)
})

test('list.js 真的接上：每個來源都呼叫對應的記錄', () => {
  const src = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  for (const needle of ['stateLog.aiCliStatus(', 'stateLog.aiCliDetect(', 'stateLog.claudeMod(', 'stateLog.cwdAdded(', 'stateLog.cwdRemoved(', 'stateLog.cwdRejected(', "console.info('[ASN]', text)"]) {
    assert.ok(src.includes(needle), `list.js 少了 ${needle}`)
  }
  assert.equal((src.match(/stateLog\.cwdRejected\(/g) ?? []).length, 4, '加入×3（瀏覽、建議、夥伴對話框）＋移除×1 都要記拒絕原因')
})
