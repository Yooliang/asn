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
    else if (k === '--help' || k === '-h') a.help = true
    else throw new Fail(1, `不認得的參數 ${k}\n${USAGE}`)
  }
  return a
}

// 機器節點：IRORI_RELAY_ID → ~/.irori-relay/node → 唯一的 machine-<ID> 資料夾
function machineNode() {
  const env = (process.env.IRORI_RELAY_ID || '').trim()
  if (env) return env
  try { const v = fs.readFileSync(path.join(HOME_DIR, 'node'), 'utf8').trim(); if (v) return v } catch {}
  let dirs = []
  try { dirs = fs.readdirSync(HOME_DIR).filter(n => /^machine-[A-Za-z0-9_-]+$/.test(n)) } catch {}
  if (dirs.length === 1) return dirs[0].slice('machine-'.length)
  throw new Fail(1, '認不出這台機器的節點代號：設環境變數 IRORI_RELAY_ID，或在 ~/.irori-relay/node 寫上節點代號')
}

function processTable() {
  const txt = process.platform === 'win32'
    ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    : execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 20_000 })
  const t = new Map()
  for (const line of txt.split(/\r?\n/)) { const m = line.trim().split(/\s+/); if (m.length === 2) t.set(Number(m[0]), Number(m[1])) }
  return t
}

// 沿父行程鏈往上，第一個有 ~/.claude/sessions/<pid>.json 的就是呼叫者所在的 claude 視窗
export function findCaller() {
  const dir = path.join(os.homedir(), '.claude', 'sessions')
  let table
  try { table = processTable() } catch (e) { throw new Fail(2, `讀不到行程表，無法判定寄件視窗：${e.message}`) }
  let pid = table.get(process.pid) ?? process.ppid
  for (let hops = 0; pid && hops < 40; hops++) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), 'utf8'))
      if (Number(j.pid) === pid) {
        if (typeof j.name === 'string' && j.name.trim()) return { pid, name: j.name.trim() }
        throw new Fail(2, `找到 claude 視窗（pid ${pid}）但它沒有名字，無法當寄件人；請先 /rename`)
      }
    } catch (e) { if (e instanceof Fail) throw e }
    pid = table.get(pid)
  }
  throw new Fail(2, '拒絕：找不到呼叫者所屬的 Claude 視窗（只有在 Claude 視窗裡執行才能寄信）')
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
