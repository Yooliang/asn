// 最小 ACP 用戶端測試：用假 ACP agent 驗證「initialize → session/new → session/prompt → 收串流文字」、
// 權限請求一律拒絕、子行程環境是白名單（金鑰不外洩）。完全不碰真的 AI。
// 執行：node --test relay/machine/test/acp-client.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpClient, cleanEnv } from '../engines/acp-client.mjs'

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-acp-agent.mjs')

test('cleanEnv：只留白名單，金鑰類一律不帶', () => {
  const env = cleanEnv({ PATH: '/bin', OPENAI_API_KEY: 'x', GEMINI_API_KEY: 'x', ANTHROPIC_API_KEY: 'x', IRORI_RELAY_KEY: 'x', MY_TOKEN: 'x', USERPROFILE: 'C:\\u' })
  assert.deepEqual(Object.keys(env).sort(), ['PATH', 'USERPROFILE'])
  assert.equal(cleanEnv({ PATH: '/bin' }, { A: '1' }).A, '1')
})

test('送一句拿回覆；權限請求被拒絕；update 種類被記錄', async () => {
  const c = new AcpClient({ command: process.execPath, args: [FAKE], cwd: os.tmpdir(), env: cleanEnv(process.env) }).start()
  try {
    const init = await c.initialize()
    assert.equal(init.agentInfo.name, 'fake-acp')
    const s = await c.newSession(os.tmpdir())
    const r = await c.prompt(s.sessionId, 'asn-probe ping', 10_000)
    assert.equal(r.stopReason, 'end_turn')
    assert.equal(r.text, '收到：asn-probe ping（權限被拒）')
    assert.ok(c.updates.includes('agent_message_chunk'))
  } finally { c.stop() }
})

test('子行程拿不到呼叫端的金鑰環境變數', async () => {
  const env = cleanEnv({ ...process.env, OPENAI_API_KEY: 'sk-should-not-leak', FAKE_ACP_ECHO_ENV: 'OPENAI_API_KEY' })
  assert.equal(env.OPENAI_API_KEY, undefined)
  const c = new AcpClient({ command: process.execPath, args: [FAKE], cwd: os.tmpdir(), env: { ...env, FAKE_ACP_ECHO_ENV: 'OPENAI_API_KEY' } }).start()
  try {
    await c.initialize()
    const s = await c.newSession(os.tmpdir())
    const r = await c.prompt(s.sessionId, 'x', 10_000)
    assert.match(r.text, /\[env OPENAI_API_KEY=absent\]/)
  } finally { c.stop() }
})

test('agent 行程掛掉：等待中的請求被拒絕，不會無限卡住', async () => {
  const c = new AcpClient({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: os.tmpdir(), env: cleanEnv(process.env) }).start()
  await assert.rejects(c.initialize(), /結束了|逾時/)
  c.stop()
})
