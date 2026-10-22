// 假的 agy（原生 stream-json 模式）：給 acp 轉接器的測試用，不碰任何真的 AI。事件格式照 agy 1.2.16 實測。
// 訊息裡的暗號決定行為（前導的工作者說明、[RELAY 來信] 標頭會被忽略）：
//   @@WRITE <路徑>   送出寫檔工具步驟，150ms 後才真的寫（絆線測試：被殺就不會有檔案）
//   @@RUN <指令>     送出執行指令步驟；沒帶 --dangerously-skip-permissions 就被「權限拒絕」（空回覆＋denied_actions）
//   @@AUTH / @@QUOTA 回 status=ERROR 的 result 並結束（結束碼 1）
//   @@SLEEP          送出一個步驟之後就不再有動靜（看門狗測試）
//   @@CRASH          往 stderr 寫字然後結束碼 3
//   @@ENV <名稱>     回覆該環境變數有沒有被帶進來
// 環境變數 FAKE_AGY_STATE：資料夾，存各 conversation 已經跑過幾輪（模擬 --conversation 可恢復）。
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const argv = process.argv.slice(2)
const flag = n => argv.includes(n)
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : '' }
const stateDir = process.env.FAKE_AGY_STATE || ''
const out = o => process.stdout.write(JSON.stringify(o) + '\n')
const stateFile = id => path.join(stateDir, `${id}.json`)
const loadTurns = id => { try { return JSON.parse(fs.readFileSync(stateFile(id), 'utf8')).turns } catch { return 0 } }
const saveTurns = (id, turns) => { if (stateDir) fs.writeFileSync(stateFile(id), JSON.stringify({ turns })) }

let conv = opt('--conversation')
if (conv && !(stateDir && fs.existsSync(stateFile(conv)))) { process.stderr.write(`warning: conversation "${conv}" not found\n`); conv = '' }
if (!conv) conv = `conv-${Math.random().toString(16).slice(2, 10)}`
let turns = loadTurns(conv)
let inited = false
let step = 0
const sleep = ms => new Promise(r => setTimeout(r, ms))

const rl = readline.createInterface({ input: process.stdin })
let chain = Promise.resolve()
rl.on('line', line => { chain = chain.then(() => handle(line)).catch(e => { process.stderr.write(String(e)); process.exit(4) }) })

async function handle(line) {
  const m = JSON.parse(line)
  const content = String(m.message?.content ?? '')
  if (!inited) { inited = true; out({ event: 'init', conversation_id: conv, init: { cwd: process.cwd(), tools: ['view_file', 'write_to_file', 'run_command'] } }) }
  turns++
  saveTurns(conv, turns)
  out({ event: 'step_update', step_update: { conversation_id: conv, step_index: step++, state: 'DONE', step_type: 'user_input' } })
  const mail = content.includes('\n---\n') ? content.slice(content.indexOf('\n---\n') + 5) : content
  const body = mail.replace(/^\[RELAY 來信\][^\n]*\n?/, '')
  const resultOf = (response, extra = {}) => out({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response, duration_seconds: 0.01, num_turns: 1, usage: { input_tokens: 1 }, ...extra } })
  const fail = (err, code) => { out({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: err } }); setTimeout(() => process.exit(code), 20) }
  const flags = `${flag('--dangerously-skip-permissions') ? 'full' : 'normal'}${opt('--model') ? `/${opt('--model')}` : ''}`

  let t
  if ((t = /@@WRITE\s+(\S+)/.exec(body))) {
    const si = step++
    out({ event: 'step_update', step_update: { conversation_id: conv, step_index: si, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { TargetFile: t[1] } } } })
    await sleep(150)
    fs.writeFileSync(t[1], 'written-by-fake-agy')
    out({ event: 'step_update', step_update: { conversation_id: conv, step_index: si, state: 'DONE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { TargetFile: t[1] } } } })
    return resultOf(`已寫入 ${t[1]}`)
  }
  if ((t = /@@RUN\s+(.+)/.exec(body))) {
    const si = step++
    const tool = { name: 'run_command', parameters: { CommandLine: t[1].trim() } }
    out({ event: 'step_update', step_update: { conversation_id: conv, step_index: si, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: tool } })
    if (flag('--dangerously-skip-permissions')) {
      out({ event: 'step_update', step_update: { conversation_id: conv, step_index: si, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: tool } })
      return resultOf(`ran: ${t[1].trim()} (${flags})`)
    }
    out({ event: 'step_update', step_update: { conversation_id: conv, step_index: si, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { ...tool, error: { type: 'TOOL_ERROR', message: `permission check failed for command "${t[1].trim()}": user denied permission` } } } })
    return resultOf('', { denied_actions: [{ action: 'command', display_name: 'RunCommand' }] })
  }
  if (/@@MISSING/.test(body)) {
    const si = step++
    out({ event: 'step_update', step_update: { conversation_id: conv, step_index: si, state: 'ERROR', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: 'C:/nope.md' }, error: { type: 'TOOL_ERROR', message: 'declaring permissions: cortex tool view_file: convert tool call for permissions: model output error: failed to read file: The system cannot find the file specified.' } } } })
    return resultOf('找不到那個檔案')
  }
  if (/@@HEAD/.test(body)) return resultOf(content.split('\n').find(l => l.startsWith('[RELAY 來信]')) ?? '')
  if (/授權已核可/.test(body)) return resultOf(`ran-after-grant (${flags})`)
  if (/@@AUTH/.test(body)) return fail('not logged in: run `agy` and sign in with your Google account (authentication required)', 1)
  if (/@@QUOTA/.test(body)) return fail('RESOURCE_EXHAUSTED: quota exceeded for this account', 1)
  if (/@@CRASH/.test(body)) { process.stderr.write('fatal: boom\n'); process.exit(3) }
  if (/@@SLEEP/.test(body)) { out({ event: 'step_update', step_update: { conversation_id: conv, step_index: step++, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'zzz' } }); return }
  if ((t = /@@ENV\s+(\S+)/.exec(body))) return resultOf(`[env ${t[1]}=${process.env[t[1]] ? 'present' : 'absent'}]`)
  const hadPreamble = content.includes('ASN 收發室替你啟動的背景工作者')
  out({ event: 'step_update', step_update: { conversation_id: conv, step_index: step++, state: 'DONE', step_type: 'agent_response', text_delta: 'x' } })
  resultOf(`收到：${body.trim().slice(0, 80)} [第${turns}輪 ${flags}${hadPreamble ? ' 含說明' : ''} cwd=${path.basename(process.cwd())}]`)
}
rl.on('close', () => process.exit(0))
