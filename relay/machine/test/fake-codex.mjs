// 測試替身：假的 codex 命令列（Codex 轉接器的契約測試用；IRORI_CODEX_SCRIPT 指到這支就取代真的 codex）。
// 只實作轉接器用到的三種呼叫，形狀照 codex-cli 0.154.0 實測：
//   codex --version                       → "codex-cli 0.154.0"
//   codex app-server                      → stdio JSON-RPC（initialize、account/read、account/rateLimits/read、thread/read、thread/turns/list、
//                                            thread/start、thread/name/set、thread/inject_items）；每個呼叫記到 FAKE_CODEX_CALLS
//   codex queue --thread X --message T    → 在 state 裡替該 thread 加一個進行中的 turn（FAKE_CODEX_REPLY_MS 後才算完成）
// 環境變數：FAKE_CODEX_STATE（狀態 JSON 檔）、FAKE_CODEX_CALLS（呼叫記錄，一行一筆）、FAKE_CODEX_REPLY（最終回覆文字）、
//   FAKE_CODEX_REPLY_MS（多久後 turn 完成，預設 300）、FAKE_CODEX_TURN（reply｜fail｜never）、FAKE_CODEX_QUEUE_FAIL（有值＝queue 失敗，值＝訊息）、
//   FAKE_CODEX_VERSION、CODEX_HOME（鎖檔與 session_index.jsonl 放這裡）
// 狀態檔：{ login: bool, limit: bool, threads: [{ id, name, cwd, path, ephemeral?, parentThreadId?, updatedAt, turns: [...] }] }
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const STATE = process.env.FAKE_CODEX_STATE
const CALLS = process.env.FAKE_CODEX_CALLS
const HOME = process.env.CODEX_HOME
const record = o => { if (CALLS) fs.appendFileSync(CALLS, JSON.stringify(o) + '\n') }
const load = () => JSON.parse(fs.readFileSync(STATE, 'utf8'))
const save = st => fs.writeFileSync(STATE, JSON.stringify(st))
const uuid = n => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`

// 到時間的進行中 turn 算完成（lazy：誰讀到誰結算）
function finalize(st) {
  const now = Date.now()
  let dirty = false
  for (const t of st.threads) for (const turn of t.turns) {
    if (turn.status !== 'inProgress' || turn.completeAt == null || turn.completeAt > now) continue
    dirty = true
    turn.completedAt = Math.floor(now / 1000)
    if (turn.willFail) { turn.status = 'failed'; turn.error = { message: 'You have hit your usage limit', codexErrorInfo: 'usageLimitExceeded' } }
    else { turn.status = 'completed'; turn.items.push({ type: 'agentMessage', id: `m${turn.id}`, text: process.env.FAKE_CODEX_REPLY ?? 'fake-reply', phase: 'final_answer' }) }
    t.updatedAt = Math.floor(now / 1000)
  }
  if (dirty) save(st)
  return st
}
const summary = t => ({ id: t.id, name: t.name ?? null, cwd: t.cwd, path: t.path ?? null, ephemeral: !!t.ephemeral, parentThreadId: t.parentThreadId ?? null,
  agentRole: t.agentRole ?? null, updatedAt: t.updatedAt ?? 0, status: { type: 'notLoaded' }, turns: [] })

const argv = process.argv.slice(2)
const flag = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }

if (argv[0] === '--version') {
  console.log(`codex-cli ${process.env.FAKE_CODEX_VERSION || '0.154.0'}`)
} else if (argv[0] === 'queue') {
  record({ cmd: 'queue', argv })
  if (process.env.FAKE_CODEX_QUEUE_FAIL) { console.error(`Error: ${process.env.FAKE_CODEX_QUEUE_FAIL}`); process.exit(1) }
  const st = load()
  const key = flag('--thread')
  const t = st.threads.find(x => x.id === key || x.name === key)
  if (!t) { console.error(`Error: No active session found matching '${key}'.`); process.exit(1) }
  // 真的 codex（clap）：內文若以 -- 開頭，分開寫（--message TEXT）會被當旗標而失敗；連寫（--message=TEXT）才安全
  if (argv.includes('--message')) { console.error(`error: a value is required for '--message <TEXT>' but none was supplied`); process.exit(2) }
  const joined = argv.find(a => a.startsWith('--message='))
  if (joined == null) { console.error('error: the following required arguments were not provided: --message <TEXT>'); process.exit(2) }
  const message = joined.slice('--message='.length)
  const mode = process.env.FAKE_CODEX_TURN || 'reply'
  const n = t.turns.length + 1
  t.turns.push({
    id: `${t.id}-turn${n}`, status: 'inProgress', completedAt: null, error: null,
    completeAt: mode === 'never' ? null : Date.now() + Number(process.env.FAKE_CODEX_REPLY_MS || 300), willFail: mode === 'fail',
    items: [{ type: 'userMessage', id: `u${n}`, content: [{ type: 'text', text: message, text_elements: [] }] }],
  })
  save(st)
  console.log(`Queued message ${uuid(n)} for thread ${t.id}.`)
} else if (argv[0] === 'app-server') {
  const made = []   // 這個行程替 thread/start 建的鎖檔，結束時刪掉（真 codex 乾淨結束才釋放 thread-writer-lock）
  const cleanup = () => { for (const f of made) try { fs.unlinkSync(f) } catch {} }
  process.on('exit', cleanup)
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('close', () => process.exit(0))
  const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n')
  const error = (id, message) => process.stdout.write(JSON.stringify({ id, error: { code: -32603, message } }) + '\n')
  rl.on('line', line => {
    let m; try { m = JSON.parse(line) } catch { return }
    if (m.id == null) return
    record({ cmd: 'rpc', method: m.method, params: m.params })
    const st = finalize(load())
    const find = id => st.threads.find(t => t.id === id)
    switch (m.method) {
      case 'initialize': return reply(m.id, { userAgent: 'fake-codex', codexHome: HOME })
      case 'account/read': return reply(m.id, st.login === false ? { account: null, requiresOpenaiAuth: true } : { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: true })
      case 'account/rateLimits/read': return reply(m.id, { ordinaryUsageAllowed: !st.limit, rateLimits: { primary: { usedPercent: st.limit ? 100 : 5, windowDurationMins: 300, resetsAt: 1791058114 }, secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1791644914 }, rateLimitReachedType: st.limit ? 'primary' : null } })
      case 'thread/read': { const t = find(m.params.threadId); return t ? reply(m.id, { thread: summary(t) }) : error(m.id, 'no rollout found') }
      case 'thread/turns/list': {
        const t = find(m.params.threadId); if (!t) return error(m.id, 'no rollout found')
        const data = [...t.turns].reverse().slice(0, m.params.limit ?? 20).map(({ completeAt, willFail, ...x }) => x)
        return reply(m.id, { data, nextCursor: null })
      }
      case 'thread/start': {
        const n = st.threads.length + 1
        const t = { id: uuid(0x1000 + n), name: null, cwd: m.params.cwd, path: null, updatedAt: Math.floor(Date.now() / 1000), turns: [] }
        st.threads.push(t); save(st)
        if (HOME) { const d = path.join(HOME, 'thread-writer-locks'); fs.mkdirSync(d, { recursive: true }); const f = path.join(d, `${t.id}.lock`); fs.writeFileSync(f, ''); made.push(f) }
        return reply(m.id, { thread: summary(t) })
      }
      case 'thread/name/set': {
        const t = find(m.params.threadId); if (!t) return error(m.id, 'unknown thread')
        t.name = m.params.name; save(st)
        if (HOME) fs.appendFileSync(path.join(HOME, 'session_index.jsonl'), JSON.stringify({ id: t.id, thread_name: t.name, updated_at: new Date().toISOString() }) + '\n')
        return reply(m.id, {})
      }
      case 'thread/inject_items': {
        const t = find(m.params.threadId); if (!t) return error(m.id, 'unknown thread')
        t.seeded = m.params.items; t.path = path.join(HOME || '.', `rollout-${t.id}.jsonl`); save(st)
        return reply(m.id, {})
      }
      default: return error(m.id, `method not found: ${m.method}`)
    }
  })
} else {
  console.error(`fake codex: unsupported ${argv.join(' ')}`)
  process.exit(2)
}
