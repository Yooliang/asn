#!/usr/bin/env node
// irori-send：本機 Claude 視窗主動寄信給仲介成員／群組，不經收發室、不經任何模型。
//   node send.mjs --to XISU --body "內文" [--reply-to <信件id>]
//   node send.mjs --to W/W-政策 --body-file msg.txt
//   node send.mjs --room <群組id> --body "內文"
//   echo 內文 | node send.mjs --to XISU --body -
// 用這台機器的節點金鑰（~/.irori-relay/<節點>.key，橋用的同一把）直接呼叫 relay。
// 寄件視窗名不能自填：沿父行程鏈往上找 claude 程序，對照 ~/.claude/sessions/<pid>.json 的 name 當 from_agent；找不到就拒絕。
// 輸出 `sent id=…`（或 `posted room=… seq=…`）；錯誤印到 stderr，exit code：1 用法／內容、2 認不出呼叫者、3 超量、4 後端錯誤。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME_DIR = path.join(os.homedir(), '.irori-relay')
const BASE_URL = (process.env.IRORI_RELAY_URL || 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/irori-relay').replace(/\/+$/, '')
const LIMIT = Number(process.env.IRORI_SEND_PER_HOUR || 30)
const MAX_BODY = 20000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/
const USAGE = `用法：
  node send.mjs --to <成員代號 | 節點/視窗名> --body "<內文>" [--reply-to <信件id>]
  node send.mjs --room <群組id> --body "<內文>"
  --body-file <檔>   內文從檔案讀；--body -  內文從 stdin 讀
  --whoami           不寄信，印出父行程鏈、session 對照、節點判定（除錯用）
內文至多 ${MAX_BODY} 字。寄件人（視窗名）由本程式自動判定，不能自填；信任一律是 member。`

class Fail extends Error { constructor(code, msg) { super(msg); this.code = code } }

export function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const need = () => { if (i + 1 >= argv.length) throw new Fail(1, `${k} 缺少參數\n${USAGE}`); return argv[++i] }
    if (k === '--to') a.to = need()
    else if (k === '--room') a.room = need()
    else if (k === '--body') a.body = need()
    else if (k === '--body-file') a.bodyFile = need()
    else if (k === '--reply-to') a.replyTo = need()
    else if (k === '--whoami') a.whoami = true
    else if (k === '--help' || k === '-h') a.help = true
    else throw new Fail(1, `不認得的參數 ${k}\n${USAGE}`)
  }
  return a
}

// 機器節點：IRORI_RELAY_ID → ~/.irori-relay/node → 橋正在跑的 machine-<ID> → 唯一有金鑰檔的 machine-<ID>
function machineNode() {
  const env = (process.env.IRORI_RELAY_ID || '').trim()
  if (env) return env
  try { const v = fs.readFileSync(path.join(HOME_DIR, 'node'), 'utf8').trim(); if (v) return v } catch {}
  let ids = []
  try { ids = fs.readdirSync(HOME_DIR).filter(n => /^machine-[A-Za-z0-9_-]+$/.test(n)).map(n => n.slice('machine-'.length)) } catch {}
  const alive = id => { try { process.kill(Number(fs.readFileSync(path.join(HOME_DIR, `machine-${id}`, 'bridge.pid'), 'utf8')), 0); return true } catch (e) { return e.code === 'EPERM' } }
  const live = ids.filter(alive)
  if (live.length === 1) return live[0]
  const keyed = ids.filter(id => fs.existsSync(path.join(HOME_DIR, `${id}.key`)))
  if (keyed.length === 1) return keyed[0]
  throw new Fail(1, `認不出這台機器的節點代號（候選：${(live.length ? live : keyed.length ? keyed : ids).join('、') || '無'}）：設環境變數 IRORI_RELAY_ID，或在 ~/.irori-relay/node 寫上節點代號`)
}

// 行程表：pid -> {ppid, name}
function processTable() {
  const txt = process.platform === 'win32'
    ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    : execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 20_000 }).replace(/^\s*(\d+)\s+(\d+)\s+/gm, '$1|$2|')
  const t = new Map()
  for (const line of txt.split(/\r?\n/)) { const m = line.trim().split('|'); if (m.length >= 2 && /^\d+$/.test(m[0])) t.set(Number(m[0]), { ppid: Number(m[1]), name: m[2] ?? '' }) }
  return t
}

const sessionsDir = () => path.join(os.homedir(), '.claude', 'sessions')
function readSession(pid) {
  try { const j = JSON.parse(fs.readFileSync(path.join(sessionsDir(), `${pid}.json`), 'utf8')); return Number(j.pid) === pid ? j : null } catch { return null }
}
const alivePid = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

// 判定呼叫者（回傳證據供 --whoami 印出）：
//  1. 沿父行程鏈往上，第一個有 ~/.claude/sessions/<pid>.json 的程序就是呼叫者所在的 claude 視窗（Windows PID，msys 的 bash 也在鏈上）。
//  2. 鏈上找不到時的備援：Claude Code 對 Bash 指令匯出 CLAUDE_CODE_MESSAGING_SOCKET（該視窗專屬的 pipe 路徑），
//     對上某個還活著的 session 的 messagingSocketPath 就算（涵蓋 nohup／背景化後父行程已消失的情況）。獨立啟動的程式沒有這個環境變數。
export function inspectCaller() {
  const ev = { chain: [], tableError: null, viaChain: null, viaEnv: null, envSocket: process.env.CLAUDE_CODE_MESSAGING_SOCKET || '' }
  let table = null
  try { table = processTable() } catch (e) { ev.tableError = e.message }
  if (table) {
    let pid = table.get(process.pid)?.ppid ?? process.ppid
    for (let hops = 0; pid && hops < 40; hops++) {
      const s = readSession(pid)
      ev.chain.push({ pid, name: table.get(pid)?.name ?? '(已結束)', session: s ? (s.name || '(無名)') : null })
      if (s) { ev.viaChain = { pid, name: typeof s.name === 'string' ? s.name.trim() : '' }; break }
      pid = table.get(pid)?.ppid
    }
  }
  if (ev.envSocket) {
    try {
      for (const f of fs.readdirSync(sessionsDir()).filter(f => /^\d+\.json$/.test(f))) {
        const s = readSession(Number(f.slice(0, -5)))
        if (s && s.messagingSocketPath === ev.envSocket && alivePid(s.pid)) { ev.viaEnv = { pid: s.pid, name: typeof s.name === 'string' ? s.name.trim() : '' }; break }
      }
    } catch {}
  }
  return ev
}
export function findCaller() {
  const ev = inspectCaller()
  const hit = ev.viaChain ?? ev.viaEnv
  if (!hit) throw new Fail(2, `拒絕：找不到呼叫者所屬的 Claude 視窗（只有在 Claude 視窗裡執行才能寄信）${ev.tableError ? `；讀行程表失敗：${ev.tableError}` : ''}\n除錯：加 --whoami 看父行程鏈與 session 對照`)
  if (!hit.name) throw new Fail(2, `找到 claude 視窗（pid ${hit.pid}）但它沒有名字，無法當寄件人；請先 /rename`)
  return { pid: hit.pid, name: hit.name }
}
function whoami() {
  const ev = inspectCaller()
  console.log(`node pid=${process.pid} ppid=${process.ppid} platform=${process.platform} home=${os.homedir()}`)
  console.log(`CLAUDE_CODE_MESSAGING_SOCKET=${ev.envSocket || '(未設)'}`)
  if (ev.tableError) console.log(`行程表讀取失敗：${ev.tableError}`)
  console.log('父行程鏈（由近到遠）：'); for (const c of ev.chain) console.log(`  pid=${c.pid} ${c.name}${c.session ? `  <== session「${c.session}」` : ''}`)
  console.log(`判定（行程鏈）：${ev.viaChain ? `pid=${ev.viaChain.pid} name=${ev.viaChain.name || '(無名)'}` : '無'}`)
  console.log(`判定（環境變數備援）：${ev.viaEnv ? `pid=${ev.viaEnv.pid} name=${ev.viaEnv.name || '(無名)'}` : '無'}`)
  let sess = []; try { sess = fs.readdirSync(sessionsDir()).filter(f => /^\d+\.json$/.test(f)).map(f => readSession(Number(f.slice(0, -5)))).filter(Boolean) } catch {}
  console.log('~/.claude/sessions：'); for (const s of sess) console.log(`  pid=${s.pid} name=${s.name ?? '(無名)'} kind=${s.kind} entrypoint=${s.entrypoint}`)
  try { console.log(`機器節點判定：${machineNode()}`) } catch (e) { console.log(`機器節點判定失敗：${e.message}`) }
}

// 每視窗每小時上限，記在 ~/.irori-relay/send-rate.json（暫存檔＋rename，避免寫壞）
function takeRate(window) {
  const file = path.join(HOME_DIR, 'send-rate.json')
  let all = {}
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')) || {} } catch {}
  const now = Date.now()
  for (const k of Object.keys(all)) { all[k] = (all[k] || []).filter(t => now - t < 3_600_000); if (!all[k].length) delete all[k] }
  const recent = all[window] ?? []
  if (recent.length >= LIMIT) throw new Fail(3, `被擋：視窗「${window}」每小時最多寄 ${LIMIT} 封，${Math.ceil((recent[0] + 3_600_000 - now) / 60000)} 分鐘後再試`)
  all[window] = [...recent, now]
  fs.mkdirSync(HOME_DIR, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(all)); fs.renameSync(tmp, file)
}

async function call(key, action, body) {
  const res = await fetch(`${BASE_URL}?action=${action}`, {
    method: 'POST', headers: { 'x-relay-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text(); let data = null
  try { data = JSON.parse(text) } catch {}
  if (!res.ok) throw new Fail(4, `${action} HTTP ${res.status} ${data?.error ?? ''}`.trim())
  return data
}

export async function main(argv) {
  const a = parseArgs(argv)
  if (a.help) { console.log(USAGE); return 0 }
  if (a.whoami) { whoami(); return 0 }
  if (!a.to === !a.room) throw new Fail(1, `--to 與 --room 要二選一\n${USAGE}`)
  let body = a.body
  if (a.bodyFile) body = fs.readFileSync(a.bodyFile, 'utf8')
  else if (body === '-') body = fs.readFileSync(0, 'utf8')
  body = (body ?? '').replace(/\s+$/, '')
  if (!body) throw new Fail(1, `內文是空的\n${USAGE}`)
  if (body.length > MAX_BODY) throw new Fail(1, `內文 ${body.length} 字，超過 ${MAX_BODY} 字`)
  if (a.replyTo && !UUID_RE.test(a.replyTo)) throw new Fail(1, '--reply-to 要是信件 id（uuid）')
  let toNode = '', toAgent = ''
  if (a.to) {
    const i = a.to.indexOf('/')
    toNode = i < 0 ? a.to : a.to.slice(0, i); toAgent = i < 0 ? '' : a.to.slice(i + 1)
    if (!ID_RE.test(toNode)) throw new Fail(1, `--to ${a.to} 的成員代號格式不對`)
  }
  const node = machineNode()
  if (toNode === node) throw new Fail(1, '收件人是本機節點；本機視窗之間請直接用 SendMessage')
  let key = (process.env.IRORI_RELAY_KEY || '').trim()
  if (!key) { try { key = fs.readFileSync(path.join(HOME_DIR, `${node}.key`), 'utf8').trim() } catch {} }
  if (!key) throw new Fail(1, `找不到機器金鑰 ${path.join(HOME_DIR, node + '.key')}`)
  const caller = findCaller()   // 先認人，再計次、再寄
  takeRate(caller.name)
  if (a.room) {
    const r = await call(key, 'room_post', { room: a.room, body, from_agent: caller.name })
    console.log(`posted room=${a.room}${r?.seq != null ? ` seq=${r.seq}` : ''} from=${node}/${caller.name}`)
  } else {
    const r = await call(key, 'send', { to_node: toNode, to_agent: toAgent || undefined, body, reply_to: a.replyTo || undefined, from_agent: caller.name })
    console.log(`sent id=${r?.id} to=${a.to} from=${node}/${caller.name}`)
  }
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 不呼叫 process.exit()：Windows 上 fetch 剛結束就強制結束，node 偶爾會在關閉 handle 時 assertion 當掉；改設 exitCode 讓事件圈自然結束
  main(process.argv.slice(2)).then(c => { process.exitCode = c }, e => {
    console.error(e instanceof Fail ? e.message : `錯誤：${e.message}`)
    process.exitCode = e instanceof Fail ? e.code : 4
  })
}
