// 通用 acp 轉接器（#134 第一期；調研與取捨見 docs/AGENT-ENGINES.md，上線步驟見該文件「第一期上線步驟」）。
// 這個轉接器不接「使用者已經開著的視窗」（那只有 Claude／Codex 各自的入口辦得到），而是由收發室橋依設定
// 長駐啟動一批「工作者」（背景 AI，例如 Gemini），名單上以工作者出現；收到信就送一輪、把回覆寄回（橋負責帶 reply_to）。
// 設定檔 ~/.irori-relay/agents.json（範本 relay/machine/agents.example.json；IRORI_AGENTS_FILE 可改路徑）。
// 兩種驅動：protocol "agy-stream"（agy 原生 stream-json，預設、第一選擇）與 "acp"（標準 ACP，備援／其他 agent）。
// IRORI_ENGINES=claude,acp 才會載入。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApprovals, parseMailText } from './acp-approvals.mjs'
import { loadWorkersConfig } from './acp-config.mjs'
import { createAcpDriver } from './acp-driver-acp.mjs'
import { createAgyDriver } from './acp-driver-agy.mjs'
import { createWorker } from './acp-worker.mjs'
import { headReply, wantsReply } from '../mail-format.mjs'

const DRIVERS = { 'agy-stream': createAgyDriver, acp: createAcpDriver }
const defaultMakeDriver = args => DRIVERS[args.cfg.protocol](args)

// 每個工作者的 session id 存 WORK_DIR/acp-workers.json（重啟後 resume 同一段對話）。指令或協定換了就不沿用
function openStore(file, log) {
  let state = {}
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')).workers ?? {} } catch (e) { if (e.code !== 'ENOENT') log(`acp-workers.json 讀不了，當作沒有：${e.message}`) }
  const save = () => {
    const tmp = `${file}.${process.pid}.tmp`
    try { fs.writeFileSync(tmp, JSON.stringify({ version: 1, workers: state }, null, 1)); fs.renameSync(tmp, file) } catch (e) { log(`acp-workers.json 存不了：${e.message}`) }
  }
  return cfg => ({
    get: name => { const s = state[name]; return s && s.protocol === cfg.protocol && s.command === cfg.command ? s.session_id : '' },
    set: (name, id) => { state[name] = { session_id: id, protocol: cfg.protocol, command: cfg.command, updated: new Date().toISOString() }; save() },
  })
}

// ctx：{ log, workDir, mailboxName, env?, send? }。send({to_node,to_agent,body})：橋提供的寄信函式（授權詢問、登入通知用）
export function createEngine({ log, workDir, mailboxName, env = process.env, send, deps = {} }) {
  const file = env.IRORI_AGENTS_FILE || path.join(os.homedir(), '.irori-relay', 'agents.json')
  const makeDriver = deps.makeDriver ?? defaultMakeDriver
  const approvals = createApprovals({ log })
  const workers = new Map()
  let handlers = { onSent() {}, onFail() {}, onReply() {} }

  const notify = async m => { if (!send) throw new Error('橋沒有提供寄信函式'); await send(m) }

  function windowOf(w) {
    return { name: w.name, status: w.status(), cwd: w.cfg.cwd, cwd_label: w.cfg.label, engine: 'acp', engine_label: w.cfg.rosterEngine, pid: 0, kind: 'worker', noFallback: true }
  }

  return {
    id: 'acp',
    capabilities: () => ({ listWindows: true, deliver: true, openWindow: false, selfRecv: false, identity: false, fallbackByActivity: false }),
    start(h) {
      handlers = h
      const store = openStore(path.join(workDir, 'acp-workers.json'), log)
      const conf = loadWorkersConfig({ file, workDir })
      for (const e of conf.errors) log(`acp: 設定有問題，已跳過：${e}`)
      for (const w of conf.warnings) log(`acp: 設定提醒：${w}`)
      if (!conf.workers.length) log(`acp: 沒有任何工作者（${file}）。範本：relay/machine/agents.example.json`)
      for (const cfg of conf.workers) {
        try { fs.mkdirSync(cfg.cwd, { recursive: true }) } catch (e) { log(`acp: ${cfg.name} 的工作資料夾建不起來（${cfg.cwd}）：${e.message}`); continue }
        const w = createWorker({
          cfg, env, log, approvals, store: store(cfg), makeDriver,
          notify: m => notify({ ...m, from_agent: cfg.name }),
          handlers: {
            onSent: id => handlers.onSent(id),
            onFail: (id, reason) => handlers.onFail(id, reason),
            onReply: (name, text, mailId) => handlers.onReply(name, text, mailId),
          },
        })
        workers.set(cfg.name, w)
        w.start()
        log(`acp: 工作者 ${cfg.name} 啟動（protocol=${cfg.protocol} cwd=${cfg.cwd} 權限 read=${cfg.permissions.rules.read} write=${cfg.permissions.rules.write} execute=${cfg.permissions.rules.execute} network=${cfg.permissions.rules.network}）`)
      }
    },
    stop() { for (const w of workers.values()) w.stop() },
    async listWindows() {
      for (const w of workers.values()) w.maybeRevive()
      const windows = [...workers.values()].filter(w => w.listed()).map(windowOf)
      return { all: windows, windows }
    },
    async listNames() { return new Set(workers.keys()) },
    activityOf: () => 0,
    // 轉交一封信給工作者。授權回覆（寫給這個工作者、來自被問的人）在這裡攔下，不送進模型
    deliver({ id, to, text }) {
      const w = workers.get(to)
      if (!w) throw new Error(`沒有名叫 ${to} 的 acp 工作者`)
      const { node, agent, body } = parseMailText(text)
      const r = approvals.handleReply({ worker: to, from: { node, agent }, text: body })
      if (r.handled) {
        setImmediate(() => { void handlers.onSent(id); if (r.note) void handlers.onReply(to, r.note, id) })
        return
      }
      // 要不要把回覆寄回：和橋同一條規則——抬頭的 reply=yes|no 是寄件人明說的（橋從信件欄位寫上去），有就只看它；
      // reply=?（舊信沒有欄位）或舊橋沒有這個欄位才退回看內文標記（過渡期相容，之後拿掉）。寄件人是收發室的系統信照舊不寄回
      const noReply = !wantsReply(headReply(text), body) || agent.endsWith('收發室')
      w.enqueue({ id, text, sender: { node, agent }, noReply })
    },
    /** 動態加一個背景工作者（開新夥伴；同名且還在跑就拒絕） */
    addPartnerWorker(cfg) {
      if (workers.has(cfg.name)) {
        const w = workers.get(cfg.name)
        if (w.listed()) throw new Error(`已經有叫「${cfg.name}」的工作者`)
        workers.delete(cfg.name)
      }
      try { fs.mkdirSync(cfg.cwd, { recursive: true }) } catch (e) { throw new Error(`工作資料夾建不起來：${e.message}`) }
      const w = createWorker({
        cfg, env, log, approvals, store: store(cfg), makeDriver,
        notify: m => notify({ ...m, from_agent: cfg.name }),
        handlers: {
          onSent: id => handlers.onSent(id),
          onFail: (id, reason) => handlers.onFail(id, reason),
          onReply: (name, text, mailId) => handlers.onReply(name, text, mailId),
        },
      })
      workers.set(cfg.name, w)
      w.start()
      log(`acp: 動態啟動工作者 ${cfg.name}（protocol=${cfg.protocol} cwd=${cfg.cwd}）`)
    },
    // 測試／診斷用
    _workers: workers,
  }
}
