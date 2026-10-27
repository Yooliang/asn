#!/usr/bin/env node
// ACP 原型檢查工具（docs/AGENT-ENGINES.md）：對本機一個 ACP agent 做「initialize → 開新 session → 送一句 → 拿回覆」。
// 只開名字帶 asn-probe 的拋棄式 session（cwd 是暫存資料夾），不碰使用者開著的任何視窗；子行程環境是白名單（不帶任何金鑰）。
//
//   node tools-acp-probe.mjs init   <agent> [--cmd <exe> [args...]]    只做 initialize，印出能力（不花額度）
//   node tools-acp-probe.mjs prompt <agent> "<一句話>" [--cmd ...]      initialize＋session/new＋session/prompt
//   node tools-acp-probe.mjs models <agent> [--cmd ...]                initialize＋session/new，看有沒有原生切模型（0.2 B2）：
//        印 session/new 回的 models／modes；有 models 就用「目前的模型」呼叫一次 session/set_model（等於沒換）確認方法存在。不送任何一句話、不花額度
//
// <agent>：gemini（node + 全域 @google/gemini-cli bundle + --acp）、或 custom（搭配 --cmd 指定任何 ACP agent 指令）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AcpClient, cleanEnv } from './engines/acp-client.mjs'

function npmGlobalRoot() {
  const appdata = process.env.APPDATA
  return appdata ? path.join(appdata, 'npm', 'node_modules') : null
}

function resolveAgent(name, rest) {
  const i = rest.indexOf('--cmd')
  if (i >= 0) return { command: rest[i + 1], args: rest.slice(i + 2) }
  if (name === 'gemini') {
    const bundle = path.join(npmGlobalRoot() ?? '', '@google', 'gemini-cli', 'bundle', 'gemini.js')
    if (!fs.existsSync(bundle)) throw new Error('找不到全域 @google/gemini-cli（npm i -g @google/gemini-cli），或用 --cmd 指定')
    return { command: process.execPath, args: [bundle, '--acp'] }
  }
  throw new Error(`不認得的 agent：${name}（用 gemini，或 --cmd <exe> [args...]）`)
}

const [mode, agentName, ...rest] = process.argv.slice(2)
if (!['init', 'prompt', 'models'].includes(mode) || !agentName) {
  console.error('用法：tools-acp-probe.mjs init|prompt|models <agent> ["<一句話>"] [--cmd <exe> [args...]]')
  process.exit(2)
}
const authAt = rest.indexOf('--auth')
const authId = authAt >= 0 ? rest[authAt + 1] : null   // --auth <methodId>：session/new 前先 authenticate
const message = mode === 'prompt' && rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined   // --auth 要寫在 --cmd 之前
if (mode === 'prompt' && !message) { console.error('prompt 模式需要一句話'); process.exit(2) }

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-probe-acp-'))
const spec = resolveAgent(agentName, rest)
const t0 = Date.now()
const log = m => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)
const client = new AcpClient({ ...spec, cwd, env: cleanEnv(), log }).start()
try {
  const init = await client.initialize()
  log('initialize ok')
  console.log(JSON.stringify({
    protocolVersion: init.protocolVersion,
    agentInfo: init.agentInfo ?? null,
    agentCapabilities: init.agentCapabilities ?? null,
    authMethods: (init.authMethods ?? []).map(a => ({ id: a.id, name: a.name })),
  }, null, 1))
  if (mode === 'models') {
    if (authId) { await client.authenticate(authId); log(`authenticate ${authId} ok`) }
    const s = await client.newSession(cwd)
    log(`session/new ok（sessionId=${s.sessionId}）`)
    const models = s.models ?? null
    const out = { sessionNewKeys: Object.keys(s ?? {}).sort(), models: models ? { currentModelId: models.currentModelId ?? null, available: (models.availableModels ?? []).map(m => m.modelId ?? m.id ?? m.name) } : null, modes: s.modes ? { currentModeId: s.modes.currentModeId ?? null, available: (s.modes.availableModes ?? []).map(m => m.id) } : null, setModel: null }
    if (models?.currentModelId) {
      try { await client.request('session/set_model', { sessionId: s.sessionId, modelId: models.currentModelId }, 15_000); out.setModel = 'ok' } catch (e) { out.setModel = `error: ${String(e?.message ?? e).slice(0, 160)}` }
    }
    console.log(JSON.stringify(out, null, 1))
  }
  if (mode === 'prompt') {
    if (authId) { await client.authenticate(authId); log(`authenticate ${authId} ok`) }
    const s = await client.newSession(cwd)
    log(`session/new ok（sessionId=${s.sessionId}）`)
    const r = await client.prompt(s.sessionId, message)
    log(`session/prompt 結束 stopReason=${r.stopReason}`)
    console.log('--- 回覆 ---')
    console.log(r.text.trim())
    console.log(`--- update 種類：${[...new Set(client.updates)].join(', ')} ---`)
  }
} catch (e) {
  console.error(`失敗：${e.message}`)
  process.exitCode = 1
} finally {
  client.stop()
  setTimeout(() => { try { fs.rmSync(cwd, { recursive: true, force: true }) } catch { /* ignore */ } process.exit(process.exitCode ?? 0) }, 2000)
}
