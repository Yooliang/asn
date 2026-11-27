// 通用 acp 轉接器（#134 第一期；調研與取捨見 docs/AGENT-ENGINES.md，上線步驟見該文件「第一期上線步驟」）。
// 這個轉接器不接「使用者已經開著的視窗」（那只有 Claude／Codex 各自的入口辦得到），而是由收發室橋依設定
// 長駐啟動一批「工作者」（背景 AI，例如 Gemini），名單上以工作者出現；收到信就送一輪、把回覆寄回（橋負責帶 reply_to）。
// 設定檔 ~/.asn/agents.json（範本 relay/machine/agents.example.json；ASN_AGENTS_FILE 可改路徑）。
// 兩種驅動：protocol "agy-stream"（agy 原生 stream-json，預設、第一選擇）與 "acp"（標準 ACP，備援／其他 agent）。
// ASN_ENGINES=claude,acp 才會載入。
import { envGet } from '../env-compat.mjs'
import { locateHome } from '../home.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApprovals, parseMailText } from './acp-approvals.mjs'
import { loadWorkersConfig } from './acp-config.mjs'
import { createAcpDriver } from './acp-driver-acp.mjs'
import { createAgyDriver } from './acp-driver-agy.mjs'
import { createWorker } from './acp-worker.mjs'
import { headReply, wantsReply } from '../mail-format.mjs'
import { isSystemNotice } from '../system-notice.mjs'

const DRIVERS = { 'agy-stream': createAgyDriver, acp: createAcpDriver }
const defaultMakeDriver = args => DRIVERS[args.cfg.protocol](args)

// 每個工作者的 session id 存 WORK_DIR/acp-workers.json（重啟後 resume 同一段對話）。指令或協定換了就不沿用。
// 每筆另存 preamble_fp（#2351）：上次成功送出的開場說明全文的指紋；接回舊對話時指紋缺（舊帳本）或不同就重送開場說明。
// 檔案版本不變，只多一個欄位；Rust 端 acp_worker.rs 的 Store 是同一份格式
function openStore(file, log) {
  let state = {}
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')).workers ?? {} } catch (e) { if (e.code !== 'ENOENT') log(`acp-workers.json 讀不了，當作沒有：${e.message}`) }
  const save = () => {
    const tmp = `${file}.${process.pid}.tmp`
    try { fs.writeFileSync(tmp, JSON.stringify({ version: 1, workers: state }, null, 1)); fs.renameSync(tmp, file) } catch (e) { log(`acp-workers.json 存不了：${e.message}`) }
  }
  return cfg => {
    const mine = name => { const s = state[name]; return s && s.protocol === cfg.protocol && s.command === cfg.command ? s : null }
    return {
      get: name => mine(name)?.session_id ?? '',
      // 編號沒變就保留指紋；換了新對話，指紋清空（新對話還沒收過開場說明）
      set: (name, id) => {
        const keep = mine(name)?.session_id === id ? (mine(name).preamble_fp ?? '') : ''
        state[name] = { session_id: id, protocol: cfg.protocol, command: cfg.command, preamble_fp: keep, updated: new Date().toISOString() }
        save()
      },
      // 舊帳本沒有這欄＝空字串（缺）
      fp: name => mine(name)?.preamble_fp ?? '',
      // 帳本裡沒有這個工作者的對話編號就不記
      setFp: (name, fp) => { const s = mine(name); if (s && s.preamble_fp !== fp) { s.preamble_fp = fp; save() } },
    }
  }
}

// ctx：{ log, workDir, mailboxName, env?, send? }。send({to_node,to_agent,body})：橋提供的寄信函式（授權詢問、登入通知用）
export function createEngine({ log, workDir, mailboxName, env = process.env, send, deps = {} }) {
  const file = envGet(env, 'AGENTS_FILE') || locateHome('agents.json')
  const makeDriver = deps.makeDriver ?? defaultMakeDriver
  // 這台電腦實際的使用者資料夾（讀取的敏感位置清單要算進去；測試可注入假的，才不會去碰真的使用者資料夾）
  const realHome = deps.realHome ?? os.homedir()
  const approvals = createApprovals({ log })
  const workers = new Map()
  let handlers = { onSent() {}, onFail() {}, onReply() {} }
  // 帳本在引擎層級只開一次、第一次用到才開：start() 與動態開夥伴（addPartnerWorker）共用同一份
  let storeFactory = null
  const store = cfg => {
    storeFactory ??= openStore(path.join(workDir, 'acp-workers.json'), log)
    return storeFactory(cfg)
  }

  const notify = async m => { if (!send) throw new Error('橋沒有提供寄信函式'); await send(m) }

  function windowOf(w) {
    return { name: w.name, status: w.status(), cwd: w.cfg.cwd, cwd_label: w.cfg.label, engine: 'acp', engine_label: w.cfg.rosterEngine, pid: 0, kind: 'worker', noFallback: true }
  }

  return {
    id: 'acp',
    capabilities: () => ({ listWindows: true, deliver: true, openWindow: false, selfRecv: false, identity: false, fallbackByActivity: false }),
    start(h) {
      handlers = h
      const conf = loadWorkersConfig({ file, workDir })
      for (const e of conf.errors) log(`acp: 設定有問題，已跳過：${e}`)
      for (const w of conf.warnings) log(`acp: 設定提醒：${w}`)
      if (!conf.workers.length) log(`acp: 沒有任何工作者（${file}）。範本：relay/machine/agents.example.json`)
      for (const cfg of conf.workers) {
        try { fs.mkdirSync(cfg.cwd, { recursive: true }) } catch (e) { log(`acp: ${cfg.name} 的工作資料夾建不起來（${cfg.cwd}）：${e.message}`); continue }
        const w = createWorker({
          cfg, env, log, approvals, store: store(cfg), makeDriver, realHome, workDir,
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
      const noReply = !wantsReply(headReply(text), body) || isSystemNotice({ from_agent: agent })
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
        cfg, env, log, approvals, store: store(cfg), makeDriver, realHome, workDir,
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
