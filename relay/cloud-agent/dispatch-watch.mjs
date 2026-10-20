#!/usr/bin/env node
// 收發室「新信即時分派」守望程式（獨立常駐，不改 recv.mjs）。
// 只讀 inbox.jsonl；只寫 IRORI_DISPATCH_STATE_DIR：seen.jsonl、pending.jsonl、dispatch.log、dispatch.pid。
// 不寫 done.jsonl（仍由定期 inbox 巡檢任務標記已處理）。
//
// 環境變數（路徑與 recv 共用 resolveConfig）：
//   IRORI_DISPATCH_STATE_DIR   狀態目錄（預設 <信件目錄>/dispatch-state）
//   IRORI_DISPATCH_POLL_MS       備援輪詢（預設 30000）
//   IRORI_DISPATCH_DEBOUNCE_MS   fs.watch 防抖（預設 500）；同一批新信合併一次叫醒
//   IRORI_DISPATCH_FORWARD       轉交給夥伴的 to_agent（逗號分隔；預設空，見 README 範例）
//   IRORI_DISPATCH_SELF          額外視為「自己收」的 to_agent（預設空；永遠含 IRORI_CLOUD_ROSTER_NAME 與節點代號）
//   IRORI_DISPATCH_NO_WATCH=1    只用輪詢（測試用）
//   IRORI_WAKE_ENABLE=1          POST IRORI_WAKE_WEBHOOK_URL，Authorization: Bearer IRORI_WAKE_WEBHOOK_KEY
//   IRORI_CLOUD_APP              程式根（send.mjs 路徑）；IRORI_RELAY_ENV_FILE、IRORI_NODE_BIN 選用
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from './config.mjs'
import { acquirePidLock, appendLineDurable, ensureDir, readJsonl } from './lib.mjs'

const SECRET_NAMES = ['IRORI_RELAY_KEY', 'IRORI_WAKE_WEBHOOK_URL', 'IRORI_WAKE_WEBHOOK_KEY', 'IRORI_WAKE_WEBHOOK_AUTH']
const APPROVAL_RULES = [
  ['nas', /\bNAS\b|GsEnergy/i],
  ['server', /伺服器|主機|\bserver\b|GS-ERP|\bSSH\b|\bRDP\b|ZeroTier/i],
  ['delete', /刪除|刪檔|刪掉|\bdelete\b|\brm\s+-|\bdrop\s+table\b|移除檔/i],
  ['outbound-email', /寄信|寄出|發信|外寄|對外|e-?mail|郵件|\bsend_message\b/i],
]

const splitList = v => String(v ?? '').split(',').map(s => s.trim()).filter(Boolean)

export function resolveDispatchPaths(cfg, env = process.env) {
  const stateDir = (env.IRORI_DISPATCH_STATE_DIR || path.join(cfg.mailDir, 'dispatch-state')).trim()
  return {
    stateDir,
    seenFile: path.join(stateDir, 'seen.jsonl'),
    pendingFile: path.join(stateDir, 'pending.jsonl'),
    logFile: path.join(stateDir, 'dispatch.log'),
    pidFile: path.join(stateDir, 'dispatch.pid'),
    pollMs: Number(env.IRORI_DISPATCH_POLL_MS || 30_000),
    debounceMs: Number(env.IRORI_DISPATCH_DEBOUNCE_MS || 500),
    noWatch: env.IRORI_DISPATCH_NO_WATCH === '1',
    wakeEnable: env.IRORI_WAKE_ENABLE === '1',
  }
}

export function dispatchAgentSets(cfg, env = process.env) {
  const forward = new Set(splitList(env.IRORI_DISPATCH_FORWARD))
  const self = new Set([cfg.name, cfg.node, ...splitList(env.IRORI_DISPATCH_SELF)])
  return { forward, self }
}

export function redactSecrets(text, env = process.env) {
  let t = String(text ?? '')
  for (const n of SECRET_NAMES) {
    const v = (env[n] || '').trim()
    if (v.length >= 6) t = t.split(v).join('[redacted]')
  }
  return t
}

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`

export function buildReplyInstructions(m, { cfg, forward, self, env = process.env }) {
  const appRoot = (env.IRORI_CLOUD_APP || path.join(cfg.root, 'irori-relay')).trim()
  const nodeBin = (env.IRORI_NODE_BIN || process.execPath).trim()
  const sendScript = path.join(appRoot, 'relay/cloud-agent/send.mjs')
  const relayEnv = (env.IRORI_RELAY_ENV_FILE || path.join(appRoot, 'relay.env')).trim()
  const fromAddr = `${m.from_node}${m.from_agent ? '/' + m.from_agent : ''}`
  const to = String(m.to_agent ?? '').trim()
  const as = forward.has(to) ? to : (to && self.has(to) ? to : cfg.name)
  return `set -a; . ${shq(relayEnv)}; set +a; ${shq(nodeBin)} ${shq(sendScript)} --to ${shq(fromAddr)} --reply-to ${m.id} --from ${shq(as)} --body - --no-reply   # 要對方再回就改 --reply；內文從 stdin`
}

export function classifyMail(m, { cfg, forward, self, env = process.env }) {
  const to = String(m.to_agent ?? '').trim()
  const cls = forward.has(to) ? 'forward' : (!to || self.has(to)) ? 'self' : 'self-unknown-addressee'
  const text = String(m.body ?? '')
  const flags = APPROVAL_RULES.filter(([, re]) => re.test(text)).map(([k]) => k)
  if (flags.length) flags.unshift('needs-user-approval')
  const fromAddr = `${m.from_node}${m.from_agent ? '/' + m.from_agent : ''}`
  const note = cls === 'forward'
    ? `轉交給 ${to}：請夥伴用 pending 裡的 reply_instructions 回信；done 由定期巡檢標記`
    : cls === 'self-unknown-addressee'
      ? `收件人「${to}」不在 forward/self 名單，當主助手處理`
      : '主助手自己處理'
  return {
    id: m.id, from: fromAddr, to: to || null, class: cls, flags,
    expects_reply: m.expects_reply ?? null, reply_to: m.reply_to ?? null, created_at: m.created_at ?? null,
    preview: redactSecrets(text.replace(/\s+/g, ' ').slice(0, 160), env),
    reply_instructions: buildReplyInstructions(m, { cfg, forward, self, env }),
    note,
    detected_at: new Date().toISOString(),
  }
}

export async function postWake(records, env = process.env, fetchImpl = globalThis.fetch) {
  if (env.IRORI_WAKE_ENABLE !== '1') return { skipped: 'disabled' }
  const url = (env.IRORI_WAKE_WEBHOOK_URL || '').trim()
  const key = (env.IRORI_WAKE_WEBHOOK_KEY || '').trim()
  if (!url || !key) return { skipped: 'secrets-missing' }
  const summary = records.map(r => `${r.from} → ${r.to ?? '(未指定)'} [${r.class}${r.flags.length ? ' ' + r.flags.join('/') : ''}] ${r.preview.slice(0, 60)}`).join('\n')
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 15_000)
  try {
    const res = await fetchImpl(url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ event: 'irori.new_mail', ids: records.map(r => r.id), summary: redactSecrets(summary, env) }),
    })
    let runUuid = ''
    try {
      const j = JSON.parse(await res.text())
      runUuid = j?.runUuid ?? j?.run_uuid ?? j?.data?.runUuid ?? ''
    } catch {}
    return { status: res.status, runUuid: runUuid ? String(runUuid).slice(0, 64) : '' }
  } catch (e) {
    return { error: e?.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e?.name || 'error') }
  } finally { clearTimeout(t) }
}

export function createDispatchWatcher({
  cfg, env = process.env, paths = resolveDispatchPaths(cfg, env),
  forward, self, fetchImpl = globalThis.fetch, log = () => {},
  now = () => new Date().toISOString(),
}) {
  const sets = forward && self ? { forward, self } : dispatchAgentSets(cfg, env)
  forward = sets.forward
  self = sets.self
  let seen = new Set()
  let timer = null
  let running = false
  let again = false

  function writeLog(msg) { log(`${now()} ${redactSecrets(msg, env)}`) }

  async function wakeBatch(records) {
    const r = await postWake(records, env, fetchImpl)
    if (r.skipped === 'secrets-missing') writeLog(`wake skipped: secrets missing ids=${records.map(x => x.id.slice(0, 8)).join(',')}`)
    else if (r.error) writeLog(`wake POST failed: ${r.error}`)
    else writeLog(`wake POST status=${r.status}${r.runUuid ? ` runUuid=${r.runUuid}` : ''} ids=${records.length}`)
    return r
  }

  async function scan(reason) {
    if (running) { again = true; return { fresh: [] } }
    running = true
    const fresh = []
    try {
      ensureDir(paths.stateDir)
      for (const m of readJsonl(cfg.inboxFile)) {
        if (!m?.id || seen.has(m.id)) continue
        seen.add(m.id)
        const r = classifyMail(m, { cfg, forward, self, env })
        appendLineDurable(paths.pendingFile, JSON.stringify(r))
        appendLineDurable(paths.seenFile, JSON.stringify({ id: m.id, seen_at: r.detected_at }))
        writeLog(`new id=${m.id} from=${r.from} to=${r.to ?? '-'} class=${r.class} flags=${r.flags.join('/') || '-'} via=${reason}`)
        fresh.push(r)
      }
      if (fresh.length) await wakeBatch(fresh)
    } catch (e) { writeLog(`scan error: ${e?.code || e?.name}`) }
    finally {
      running = false
      if (again) { again = false; schedule('rescan') }
    }
    return { fresh }
  }

  function schedule(reason) {
    clearTimeout(timer)
    timer = setTimeout(() => { void scan(reason) }, paths.debounceMs)
  }

  function loadSeenFromDisk() {
    seen = new Set([...readJsonl(paths.seenFile), ...readJsonl(paths.pendingFile)].map(x => x?.id).filter(Boolean))
  }

  function applyDoneBaseline() {
    const done = new Set(readJsonl(cfg.doneFile).map(d => d?.id))
    let n = 0
    for (const m of readJsonl(cfg.inboxFile)) {
      if (m?.id && done.has(m.id) && !seen.has(m.id)) {
        seen.add(m.id)
        appendLineDurable(paths.seenFile, JSON.stringify({ id: m.id, seen_at: now(), baseline: true }))
        n++
      }
    }
    return n
  }

  return {
    scan, schedule, loadSeenFromDisk, applyDoneBaseline, getSeen: () => seen, paths, forward, self, writeLog,
  }
}

export function startDispatchWatch(env = process.env) {
  const cfg = resolveConfig(env)
  const paths = resolveDispatchPaths(cfg, env)
  ensureDir(paths.stateDir)
  if (!acquirePidLock(paths.pidFile, 'dispatch-watch.mjs')) {
    console.log('[dispatch] already running')
    return 0
  }
  const logs = []
  const w = createDispatchWatcher({
    cfg, env, paths, log: msg => {
      logs.push(msg)
      try { ensureDir(paths.stateDir); fs.appendFileSync(paths.logFile, msg + '\n', { mode: 0o600 }) } catch {}
    },
  })
  const firstRun = !fs.existsSync(w.paths.seenFile)
  w.loadSeenFromDisk()
  if (firstRun) {
    const n = w.applyDoneBaseline()
    w.writeLog(`baseline: ${n} already-done mails marked seen`)
  }
  w.writeLog(`dispatch-watch starting pid=${process.pid} inbox=${cfg.inboxFile} state=${paths.stateDir} wake=${paths.wakeEnable ? 'on' : 'off'}`)
  const wakeOk = env.IRORI_WAKE_ENABLE === '1' && (env.IRORI_WAKE_WEBHOOK_URL || '').trim() && (env.IRORI_WAKE_WEBHOOK_KEY || '').trim()
  w.writeLog(`wake configured: ${wakeOk ? 'yes' : 'no'}`)
  ensureDir(cfg.mailDir)
  const base = path.basename(cfg.inboxFile)
  if (paths.noWatch) w.writeLog('watch disabled (test); poll only')
  else {
    try {
      fs.watch(cfg.mailDir, (ev, f) => { if (!f || f === base) w.schedule('watch') }).on('error', e => w.writeLog(`watch error: ${e?.code}`))
    } catch (e) { w.writeLog(`watch unavailable: ${e?.code}; poll only`) }
  }
  setInterval(() => { void w.scan('poll') }, paths.pollMs)
  void w.scan('startup')
  const stop = s => { w.writeLog(`stopping (${s})`); process.exit(0) }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
  return w
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDispatchWatch()
}
