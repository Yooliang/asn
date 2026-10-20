#!/usr/bin/env node
// 切換後台前的事前檢查（只讀）：whoami 確認金鑰被後台接受；list 看各節點是否在線。
// 不呼叫 inbox／ack，不會改 delivered_at。
//   node preflight.mjs [--json]
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCore } from '../machine/relay-core.mjs'
import { NO_KEY_MSG, readKey, resolveConfig } from './config.mjs'
import { backendHostCode } from './env.mjs'

function fmtMember(m) {
  const id = m?.id ?? '?'
  const name = m?.name ?? ''
  const online = m?.online === true
  const presence = m?.presence ?? (online ? 'live' : 'idle')
  const agents = Array.isArray(m?.agents) ? m.agents.length : 0
  const label = online ? '在線' : presence === 'recent' ? '近期' : '離線'
  return `  · ${id}${name && name !== id ? `（${name}）` : ''}：${label}${agents ? `，代理 ${agents} 位` : ''}`
}

export async function runPreflight(env = process.env, { json = false } = {}) {
  const cfg = resolveConfig(env)
  const hostCode = backendHostCode(cfg.baseUrl)
  const key = readKey(cfg, env)
  if (!key) {
    const err = { ok: false, error: 'no_key', message: NO_KEY_MSG, backendHostCode: hostCode, nodeId: cfg.node }
    if (json) process.stdout.write(`${JSON.stringify(err, null, 2)}\n`)
    else process.stderr.write(`${NO_KEY_MSG}\n`)
    return { code: 2, data: err }
  }
  const core = createCore({ baseUrl: cfg.baseUrl, key, anonKey: '', log: () => {}, workDir: cfg.mailDir })
  let who
  try {
    who = await core.api('whoami')
  } catch (e) {
    const err = {
      ok: false,
      error: 'whoami_failed',
      message: e.message,
      httpStatus: e.status ?? null,
      backendHostCode: hostCode,
      nodeId: cfg.node,
    }
    if (json) process.stdout.write(`${JSON.stringify(err, null, 2)}\n`)
    else {
      process.stderr.write(`後台代號：${hostCode}\n`)
      process.stderr.write(`whoami 失敗：${e.message}\n`)
      process.stderr.write('請確認 IRORI_RELAY_KEY 與 IRORI_RELAY_URL 是否指向同一套後台。\n')
    }
    return { code: e.status === 401 ? 3 : 4, data: err }
  }
  let members = []
  try {
    const list = await core.api('list')
    members = Array.isArray(list?.members) ? list.members : []
  } catch (e) {
    const err = {
      ok: false,
      error: 'list_failed',
      message: e.message,
      backendHostCode: hostCode,
      node: who.node,
    }
    if (json) process.stdout.write(`${JSON.stringify(err, null, 2)}\n`)
    else process.stderr.write(`whoami 成功（節點 ${who.node}），但讀取名冊失敗：${e.message}\n`)
    return { code: 4, data: err }
  }
  const online = members.filter(m => m?.online === true)
  const payload = {
    ok: true,
    backendHostCode: hostCode,
    node: who.node,
    bellTopic: who.bell_topic,
    memberCount: members.length,
    onlineCount: online.length,
    members: members.map(m => ({
      id: m.id,
      name: m.name,
      online: m.online === true,
      presence: m.presence,
      last_seen_at: m.last_seen_at ?? null,
    })),
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    process.stdout.write(`後台代號：${hostCode}\n`)
    process.stdout.write(`本節點金鑰有效，代號：${who.node}\n`)
    process.stdout.write(`名冊共 ${members.length} 個節點，其中 ${online.length} 個在線（3 分鐘內有心跳）：\n`)
    for (const m of members.sort((a, b) => String(a.id).localeCompare(String(b.id)))) process.stdout.write(`${fmtMember(m)}\n`)
    if (!online.length) {
      process.stdout.write('\n提示：若預期應有人上線，可能多數節點尚未切到同一後台，或橋／recv 尚未啟動。\n')
    }
  }
  return { code: 0, data: payload }
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json')
  const r = await runPreflight(process.env, { json })
  return r.code
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(c => process.exit(c), e => { console.error(`錯誤：${e.message}`); process.exit(5) })
}
