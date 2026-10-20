#!/usr/bin/env node
// 雲端節點路徑與後台代號小幫手：例行任務不必硬編碼路徑。
//   node env.mjs paths [--json|--shell]     印出路徑（relay.env 只放路徑，不含秘密）
//   node env.mjs host-code                  依 ASN_RELAY_URL／預設值推導後台主機代號（不連網、不印完整網址）
//   node env.mjs print <鍵>                 單一路徑：home|app|node|mail|recv|inbox|send|preflight|…
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from './config.mjs'
import { applyEnvCompat } from './env-compat.mjs'

/** 從仲介 base URL 取出 Supabase 專案代號（或一般 hostname），絕不印 query／路徑。 */
export function backendHostCode(baseUrl) {
  const raw = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!raw) return 'unknown'
  try {
    const host = new URL(raw).hostname.toLowerCase()
    if (host.endsWith('.supabase.co')) return host.split('.')[0] || 'unknown'
    return host.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 48) || 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 程式與 Node、各腳本絕對路徑（不含秘密）。 */
export function cloudToolPaths(rawEnv = process.env) {
  const { env } = applyEnvCompat(rawEnv)
  const cfg = resolveConfig(env)
  const home = cfg.root
  const app = (env.ASN_CLOUD_APP || path.join(home, 'asn-relay')).trim()
  const nodeDir = (env.ASN_NODE_DIR || path.join(home, '.node')).trim()
  const nodeBin = (env.ASN_NODE_BIN || path.join(nodeDir, 'bin', 'node')).trim()
  const mailDir = cfg.mailDir
  const dispatchState = (env.ASN_DISPATCH_STATE_DIR || path.join(mailDir, 'dispatch-state')).trim()
  const script = name => path.join(app, 'relay', 'cloud-agent', name)
  return {
    home,
    app,
    nodeDir,
    nodeBin,
    mailDir,
    dispatchState,
    recvOut: path.join(mailDir, 'recv.out'),
    relayEnvFile: (env.ASN_RELAY_ENV_FILE || path.join(app, 'relay.env')).trim(),
    startScript: path.join(app, 'start.sh'),
    recv: script('recv.mjs'),
    send: script('send.mjs'),
    inbox: script('inbox.mjs'),
    attach: script('attach.mjs'),
    preflight: script('preflight.mjs'),
    envSelf: script('env.mjs'),
    dispatchWatch: script('dispatch-watch.mjs'),
    inboxFile: cfg.inboxFile,
    doneFile: cfg.doneFile,
    agentsFile: cfg.agentsFile,
    pidFile: cfg.pidFile,
    logFile: cfg.logFile,
    nodeId: cfg.node,
    backendHostCode: backendHostCode(cfg.baseUrl),
  }
}

export function pathsShellLines(p) {
  return [
    `# 由 install-cloud-node.sh 或 env.mjs paths --shell 產生；秘密請在平台環境變數設定（勿寫進檔案）`,
    `ASN_CLOUD_HOME=${shellQuote(p.home)}`,
    `ASN_CLOUD_APP=${shellQuote(p.app)}`,
    `ASN_CLOUD_MAIL_DIR=${shellQuote(p.mailDir)}`,
    `ASN_NODE_DIR=${shellQuote(p.nodeDir)}`,
    `ASN_NODE_BIN=${shellQuote(p.nodeBin)}`,
    `ASN_RELAY_ID=${shellQuote(p.nodeId)}`,
    `ASN_RELAY_ENV_FILE=${shellQuote(p.relayEnvFile)}`,
    `ASN_DISPATCH_STATE_DIR=${shellQuote(p.dispatchState)}`,
  ].join('\n') + '\n'
}

function shellQuote(s) {
  const t = String(s)
  if (/^[A-Za-z0-9_./-]+$/.test(t)) return t
  return `'${t.replace(/'/g, `'\\''`)}'`
}

const PRINT_KEYS = {
  home: p => p.home,
  app: p => p.app,
  node: p => p.nodeBin,
  nodeDir: p => p.nodeDir,
  mail: p => p.mailDir,
  recv: p => p.recv,
  send: p => p.send,
  inbox: p => p.inbox,
  attach: p => p.attach,
  preflight: p => p.preflight,
  dispatch: p => p.dispatchWatch,
  'host-code': p => p.backendHostCode,
  inboxFile: p => p.inboxFile,
  relayEnv: p => p.relayEnvFile,
  start: p => p.startScript,
}

function usage() {
  process.stderr.write(`用法：
  node env.mjs paths [--json|--shell]
  node env.mjs host-code
  node env.mjs print <鍵>   鍵：${Object.keys(PRINT_KEYS).join('、')}
`)
}

export function main(argv = process.argv.slice(2), rawEnv = process.env) {
  applyEnvCompat(rawEnv)
  const cmd = argv[0]
  if (!cmd || cmd === '--help' || cmd === '-h') { usage(); return cmd ? 0 : 1 }
  const p = cloudToolPaths(rawEnv)
  if (cmd === 'host-code') { process.stdout.write(`${p.backendHostCode}\n`); return 0 }
  if (cmd === 'paths') {
    const fmt = argv.includes('--shell') ? 'shell' : argv.includes('--json') ? 'json' : 'json'
    if (fmt === 'shell') process.stdout.write(pathsShellLines(p))
    else process.stdout.write(`${JSON.stringify(p, null, 2)}\n`)
    return 0
  }
  if (cmd === 'print') {
    const key = argv[1]
    const fn = PRINT_KEYS[key]
    if (!fn) { usage(); return 1 }
    process.stdout.write(`${fn(p)}\n`)
    return 0
  }
  usage()
  return 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
