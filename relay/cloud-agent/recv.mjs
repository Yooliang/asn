#!/usr/bin/env node
// 雲端代理的收信常駐程式：Realtime 門鈴＋每 2 分鐘補拉；pull 失敗時短退避重試（見 relay/machine/pull-retry.mjs）。
// 每封信「先 append 到 inbox.jsonl 並 fsync，寫成功才 ack」。
// 環境被重置時信還留在收發室信箱（沒 ack），不會掉；以信件 id 去重（含重啟後，從 inbox.jsonl 重建）。
// 群組：同一個 pull 裡 room_list → room_read(since) 只存後端標 for_me 的訊息（被點名，或擁有者發的），游標存 rooms.json；首次看到群組不灌歷史。
// 每 60 秒 roster 回報 resolveCloudAgents 名單（Grok 掃描＋agents.json 合併；見 grok-agents.mjs）。roster 403 只記一次、之後每小時才試一次。
//   node recv.mjs          長駐（boot.sh 用 nohup setsid 啟動）
// 不需要公開 IP：全程只往外連（HTTPS 輪詢＋WebSocket 門鈴）。exit code：2 沒金鑰、3 已有另一個在跑。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCore } from '../machine/relay-core.mjs'   // 沿用 API 呼叫與門鈴，不複製協定
import { createLog } from '../machine/safe-log.mjs'
import { normalizeAttachments } from '../machine/attach-format.mjs'
import { NO_KEY_MSG, readAnonKey, readKey, resolveCloudAgents, resolveConfig, rosterScanEnvFrom } from './config.mjs'
import { applyEnvCompat } from './env-compat.mjs'
import { backendHostCode } from './env.mjs'
import { createPullWithRetry, parsePullBackoffMs } from '../machine/pull-retry.mjs'
import { acquirePidLock, appendLineDurable, ensureDir, readJsonl, writeFileAtomic } from './lib.mjs'

const recordOf = m => ({
  id: m.id, trust: m.trust ?? null, from_node: m.from_node, from_agent: m.from_agent ?? null, to_agent: m.to_agent ?? null,
  reply_to: m.reply_to ?? null, created_at: m.created_at ?? null,
  expects_reply: typeof m.expects_reply === 'boolean' ? m.expects_reply : null,   // true＝在等回信、false＝只是告知、null＝舊信沒說
  body: m.body, received_at: new Date().toISOString(),
  // 寄件人說明（後台選填欄位，舊後台沒有）：inbox.mjs 顯示「寄件人：…」用
  ...Object.fromEntries(['sender_display', 'sender_device', 'sender_engine'].filter(k => typeof m[k] === 'string' && m[k]).map(k => [k, m[k]])),
  // 語音通話標記（後台選填布林；只認 true）：inbox.mjs 在說明行後面加固定提醒
  ...(m.voice === true ? { voice: true } : {}),
  // 附件（照片）：只存編號、檔名、型別、大小、尺寸（不存縮圖）；沒附件的信不加這個欄位。顯示與下載指令見 inbox.mjs、attach.mjs
  ...(normalizeAttachments(m.attachments).length ? { attachments: normalizeAttachments(m.attachments) } : {}),
})

// 群組訊息的 inbox 記錄（格式沿用信件，多 room／seq 等欄位；inbox.mjs 看到 room 就顯示成群組訊息）
const ROOM_PAGE = 100, ROOM_MAX_PAGES = 5
const relationOf = m => (typeof m.relation === 'string' && m.relation.length <= 16 && /^[a-z_]+$/.test(m.relation) ? m.relation : null)
const wakeOf = w => (w && Number.isInteger(w.rank) && Number.isInteger(w.total) ? { rank: w.rank, total: w.total, before: Array.isArray(w.before) ? w.before.filter(x => typeof x === 'string').slice(0, 20) : [] } : null)
export const roomRecordOf = (room, member, agent, m) => ({
  id: `room:${room.id}:${m.seq}:${member}`, room: room.id, room_name: typeof room.name === 'string' ? room.name : null, seq: m.seq,
  trust: m.trust ?? null, relation: relationOf(m),
  from_node: m.from ?? null, from_agent: m.from_name ?? null, from_label: typeof m.from_label === 'string' ? m.from_label : null,
  to_agent: agent || null, reply_to: null, created_at: m.at ?? null, expects_reply: null,
  body: m.body ?? '', received_at: new Date().toISOString(),
  ...(wakeOf(m.wake) ? { wake: wakeOf(m.wake) } : {}),
  ...(normalizeAttachments(m.attachments).length ? { attachments: normalizeAttachments(m.attachments) } : {}),
})

// 收信核心（可單獨測試）：api(action, {method, body}) 是 relay-core 的 api
export function createReceiver({
  api, cfg, log, now = () => Date.now(), listAllFn, env = rosterScanEnvFrom(cfg),
  sleep, backoffMs,
}) {
  ensureDir(cfg.mailDir, 0o700)
  const seen = new Set(readJsonl(cfg.inboxFile).map(m => m?.id).filter(Boolean))   // 重啟後靠檔案去重

  async function pullInboxOnce() {
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
  // 群組：游標存 cfg.roomsFile。成員身分＝room_list 的 mine[].member（節點本身或「節點~視窗名」）；視窗名當 as_agent
  const readCursors = () => { try { const c = JSON.parse(fs.readFileSync(cfg.roomsFile, 'utf8')); return c && typeof c === 'object' && !Array.isArray(c) ? c : {} } catch { return {} } }
  async function pullRooms() {
    let list
    try { list = (await api('room_list'))?.rooms ?? [] }
    catch (e) { if (e.status === 403 || e.status === 404) return 0; throw e }   // 舊後台／沒有群組權限：略過，不影響信箱
    const cur = readCursors()
    let stored = 0, dirty = false
    const save = () => { if (dirty) { writeFileAtomic(cfg.roomsFile, JSON.stringify(cur)); dirty = false } }
    try {
      for (const room of list) {
        for (const mine of room.mine ?? []) {
          const member = mine?.member
          if (typeof member !== 'string' || !room?.id) continue
          const key = `${room.id}|${member}`
          if (cur[key] === undefined) { cur[key] = Number(room.last_seq) || 0; dirty = true; continue }   // 第一次看到：從現在開始，不灌歷史
          const agent = member.includes('~') ? member.split('~').slice(1).join('~') : ''
          for (let page = 0; page < ROOM_MAX_PAGES; page++) {
            const res = await api(`room_read&room=${encodeURIComponent(room.id)}${agent ? `&as_agent=${encodeURIComponent(agent)}` : ''}&since=${cur[key]}&limit=${ROOM_PAGE}`)
            const msgs = (res?.messages ?? []).filter(m => Number.isInteger(m?.seq) && m.seq > cur[key]).sort((a, b) => a.seq - b.seq)
            for (const m of msgs) {
              const rec = roomRecordOf(room, member, agent, m)
              if (m.for_me === true && !seen.has(rec.id)) {
                try { appendLineDurable(cfg.inboxFile, JSON.stringify(rec)) }   // 先寫、fsync；失敗就停在這則前面，游標不動，下次補拉
                catch (e) { log(`room write failed id=${rec.id}: ${e.message} (cursor not advanced; will retry)`); return stored }
                seen.add(rec.id); stored++
                log(`room mail stored id=${rec.id} from=${rec.from_label ?? rec.from_node ?? ''}`)
              }
              cur[key] = m.seq; dirty = true
            }
            if (msgs.length < ROOM_PAGE) break
          }
        }
      }
    } finally { save() }
    return stored
  }

  // 群組拉取失敗不拖累信箱（信箱已先寫、先 ack）：只記一次 log，下一次門鈴或輪詢再拉
  let roomWarned = false
  async function pullRoomsQuiet() {
    try { await pullRooms(); if (roomWarned) log('room pull ok again'); roomWarned = false }
    catch (e) { if (!roomWarned) log(`room pull failed: ${e.message} (will retry on next pull)`); roomWarned = true }
  }

  const { pull, destroy } = createPullWithRetry({
    pullOnce: async () => { const n = await pullInboxOnce(); await pullRoomsQuiet(); return n }, log, sleep, backoffMs: backoffMs ?? parsePullBackoffMs(env),
  })

  // roster：每位代理一列（本機掃描或 config.mjs 的 loadAgents）。403＝沒有 can_roster，只記一次、之後每小時才試
  let blockedUntil = 0, warned = false
  async function rosterOnce() {
    if (now() < blockedUntil) return false
    const agents = await resolveCloudAgents(cfg, env, listAllFn)
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
  return { pull, pullOnce: pullInboxOnce, pullRooms, rosterOnce, seen, destroy }
}

export async function main(rawEnv = process.env) {
  const compat = applyEnvCompat(rawEnv)
  const env = compat.env
  const cfg = resolveConfig(env)
  ensureDir(cfg.mailDir, 0o700)
  const log = createLog(cfg.logFile, { stderr: null })   // 只寫 recv.log（20MB 輪替）；boot.sh 的 stdout/stderr 只收當機時的堆疊
  for (const n of compat.legacyNames) log(`使用舊環境變數名：${n}`)
  for (const n of compat.conflictNames) log(`環境變數 ${n} 與對應舊名同時存在且不同，以 ${n} 為準`)
  const key = readKey(cfg, env)
  if (!key) { console.error(NO_KEY_MSG); return 2 }
  if (!acquirePidLock(cfg.pidFile, 'recv.mjs')) { console.error('另一個 recv 正在執行（pid 檔有活著的程序）'); return 3 }
  process.on('SIGINT', () => process.exit(0)); process.on('SIGTERM', () => process.exit(0))
  process.on('uncaughtException', e => log(`uncaught: ${e.stack ?? e}`))
  process.on('unhandledRejection', e => log(`unhandled: ${e?.stack ?? e}`))

  const core = createCore({ baseUrl: cfg.baseUrl, key, anonKey: readAnonKey(cfg, env), log, workDir: cfg.mailDir })
  const rx = createReceiver({ api: core.api, cfg, log })
  log(`recv starting node=${cfg.node} window=${cfg.name} backend=${backendHostCode(cfg.baseUrl)} inbox=${cfg.inboxFile}`)
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
