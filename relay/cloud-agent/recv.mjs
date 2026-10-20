#!/usr/bin/env node
// 雲端代理的收信常駐程式：Realtime 門鈴＋每 2 分鐘補拉；每封信「先 append 到 inbox.jsonl 並 fsync，寫成功才 ack」。
// 環境被重置時信還留在收發室信箱（沒 ack），不會掉；以信件 id 去重（含重啟後，從 inbox.jsonl 重建）。
// 每 60 秒 roster 回報本機夥伴名單（Grok 夥伴＋ Claude 視窗，見 grok-agents.mjs；掃不到則 agents.json／預設 Grok）。roster 403 只記一次、之後每小時才試一次。
//   node recv.mjs          長駐（boot.sh 用 nohup setsid 啟動）
// 不需要公開 IP：全程只往外連（HTTPS 輪詢＋WebSocket 門鈴）。exit code：2 沒金鑰、3 已有另一個在跑。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCore } from '../machine/relay-core.mjs'   // 沿用 API 呼叫與門鈴，不複製協定
import { createLog } from '../machine/safe-log.mjs'
import { NO_KEY_MSG, readAnonKey, readKey, resolveConfig, rosterAgentsForReport } from './config.mjs'
import { acquirePidLock, appendLineDurable, ensureDir, readJsonl } from './lib.mjs'

const recordOf = m => ({
  id: m.id, trust: m.trust ?? null, from_node: m.from_node, from_agent: m.from_agent ?? null, to_agent: m.to_agent ?? null,
  reply_to: m.reply_to ?? null, created_at: m.created_at ?? null,
  expects_reply: typeof m.expects_reply === 'boolean' ? m.expects_reply : null,   // true＝在等回信、false＝只是告知、null＝舊信沒說
  body: m.body, received_at: new Date().toISOString(),
})

// 收信核心（可單獨測試）：api(action, {method, body}) 是 relay-core 的 api
export function createReceiver({ api, cfg, log, now = () => Date.now(), listAllFn, env = process.env }) {
  ensureDir(cfg.mailDir, 0o700)
  const seen = new Set(readJsonl(cfg.inboxFile).map(m => m?.id).filter(Boolean))   // 重啟後靠檔案去重
  let pulling = false, again = false

  async function pullOnce() {
    const { messages = [] } = await api('inbox')
    const ackIds = []
    for (const m of messages) {
      if (!m || typeof m.id !== 'string') continue
      if (!seen.has(m.id)) {
        try { appendLineDurable(cfg.inboxFile, JSON.stringify(recordOf(m))) }   // 先寫、fsync
        catch (e) { log(`inbox write failed id=${m.id}: ${e.message} (not acked; will retry)`); continue }   // 寫失敗：不 ack，信留在收發室信箱
        seen.add(m.id)
        log(`mail stored id=${m.id} from=${m.from_node}/${m.from_agent ?? ''} expects_reply=${m.expects_reply ?? '?'}`)
      }
      ackIds.push(m.id)   // 已寫入（含之前就寫入過、上次 ack 失敗的）才 ack
    }
    for (let i = 0; i < ackIds.length; i += 100) await api('ack', { method: 'POST', body: { ids: ackIds.slice(i, i + 100) } })
    return ackIds.length
  }
  async function pull(why) {
    if (pulling) { again = true; return }
    pulling = true
    try { do { again = false; await pullOnce() } while (again) }
    catch (e) { log(`pull failed (${why}): ${e.message}`) } finally { pulling = false }
  }

  // roster：每位代理一列（本機掃描或 config.mjs 的 loadAgents）。403＝沒有 can_roster，只記一次、之後每小時才試
  let blockedUntil = 0, warned = false
  async function rosterOnce() {
    if (now() < blockedUntil) return false
    const agents = await rosterAgentsForReport(cfg, env, listAllFn)
    try {
      await api('roster', { method: 'POST', body: { agents } })
      if (warned) log('roster ok again')
      warned = false
      return true
    } catch (e) {
      if (e.status === 403) {
        blockedUntil = now() + cfg.rosterRetryAfter403Ms
        if (!warned) log('roster forbidden (403): 這個節點沒有 can_roster；不再轟炸，每小時才重試一次')
      } else if (!warned) log(`roster post failed: ${e.message} (will keep trying quietly)`)
      warned = true
      return false
    }
  }
  return { pull, pullOnce, rosterOnce, seen }
}

export async function main(env = process.env) {
  const cfg = resolveConfig(env)
  ensureDir(cfg.mailDir, 0o700)
  const log = createLog(cfg.logFile, { stderr: null })   // 只寫 recv.log（20MB 輪替）；boot.sh 的 stdout/stderr 只收當機時的堆疊
  const key = readKey(cfg, env)
  if (!key) { console.error(NO_KEY_MSG); return 2 }
  if (!acquirePidLock(cfg.pidFile, 'recv.mjs')) { console.error('另一個 recv 正在執行（pid 檔有活著的程序）'); return 3 }
  process.on('SIGINT', () => process.exit(0)); process.on('SIGTERM', () => process.exit(0))
  process.on('uncaughtException', e => log(`uncaught: ${e.stack ?? e}`))
  process.on('unhandledRejection', e => log(`unhandled: ${e?.stack ?? e}`))

  const core = createCore({ baseUrl: cfg.baseUrl, key, anonKey: readAnonKey(cfg, env), log, workDir: cfg.mailDir })
  const rx = createReceiver({ api: core.api, cfg, log })
  log(`recv starting node=${cfg.node} window=${cfg.name} inbox=${cfg.inboxFile}`)
  void rx.rosterOnce()
  setInterval(() => void rx.rosterOnce(), cfg.rosterMs)
  for (let wait = 2000; ; wait = Math.min(wait * 2, 30_000)) {
    try { const w = await core.api('whoami'); log(`whoami node=${w.node}`); core.connectBell(w.bell_topic, why => void rx.pull(why)); break }
    catch (e) { log(`whoami failed: ${e.message}`); await core.sleep(wait) }   // 網路暫時不通／IP 剛變：退避重試
  }
  void rx.pull('startup')
  setInterval(() => void rx.pull('poll'), cfg.pollMs)
  return await new Promise(() => {})   // 長駐
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(c => { process.exit(c) }, e => { console.error(`錯誤：${e.message}`); process.exit(4) })
}
