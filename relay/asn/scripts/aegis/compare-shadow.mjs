// 並行試跑對照：對兩個節點（Node 版 aegis、Rust 版 aegis-rs）各寄同一組測試題，收回覆，只比「結構」。
// 比的項目：有沒有回、回幾封（拆分）、寄件人顯示名、有沒有重複回、耗時是否同量級。不比內容（AI 每次回答不同）。
// 用法（在 relay/asn）：
//   node scripts/aegis/compare-shadow.mjs --dry-run                       只印出會寄的題目與對象，不連網路
//   node scripts/aegis/compare-shadow.mjs [--tester <測試寄件節點>] [--agent aegis] [--questions 檔.json] [--rounds 1]
//   選項：--a aegis --b aegis-rs（對照的兩個節點）、--key-file <路徑>（寄件節點金鑰檔，預設 <ASN_HOME 或 ~/.asn>/<tester>.key）、
//         --url <後台網址>、--timeout-ms 330000、--settle-ms 30000、--poll-ms 5000
// 寄件節點是專用的測試節點（沒有別的收信者，才不會搶信）。金鑰只在記憶體裡當標頭用，不印、不寫 log。
// 結束碼：0＝全部題目結構一致；1＝有差異；2＝用法或設定錯誤。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const DEFAULT_URL = 'https://etccgmkrosbzpltudlgt.supabase.co/functions/v1/relay'
export const DEFAULT_QUESTIONS = [
  '這是並行試跑的測試信，請回覆一句話就好。',
  '請用兩段話各一句，說明你現在在做什麼。',
  '請先回「收到」，再用三個項目列出你今天可以幫忙的事。',
]
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/

export const DEFAULTS = {
  a: 'aegis', b: 'aegis-rs', tester: 'asn-tester', agent: 'aegis', questions: null, rounds: 1,
  url: DEFAULT_URL, keyFile: null, timeoutMs: 330_000, settleMs: 30_000, pollMs: 5_000, dryRun: false,
}

export function parseArgs(argv) {
  const o = { ...DEFAULTS }
  const num = (a, v) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw new Error(`${a} 要是正數`); return n }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') { o.dryRun = true; continue }
    const v = argv[++i]
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} 需要一個值`)
    if (a === '--a') o.a = v
    else if (a === '--b') o.b = v
    else if (a === '--tester') o.tester = v
    else if (a === '--agent') o.agent = v
    else if (a === '--questions') o.questions = v
    else if (a === '--url') o.url = v
    else if (a === '--key-file') o.keyFile = v
    else if (a === '--rounds') o.rounds = Math.floor(num(a, v))
    else if (a === '--timeout-ms') o.timeoutMs = num(a, v)
    else if (a === '--settle-ms') o.settleMs = num(a, v)
    else if (a === '--poll-ms') o.pollMs = num(a, v)
    else throw new Error(`不認得的參數：${a}`)
  }
  for (const k of ['a', 'b', 'tester']) if (!ID_RE.test(o[k])) throw new Error(`${k} 不是合法的節點代號：${o[k]}`)
  if (o.a === o.b) throw new Error('兩邊要是不同的節點')
  if (o.tester === o.a || o.tester === o.b) throw new Error('寄件測試節點不可以是被測節點本身')
  return o
}

/** 預設金鑰檔路徑：<ASN_HOME 或 ~/.asn>/<tester>.key（只組路徑，不讀）。 */
export function defaultKeyFile(tester, env = process.env, home = os.homedir()) {
  const dir = env.ASN_HOME || env.IRORI_HOME || path.join(home, '.asn')
  return path.join(dir, `${tester}.key`)
}

/** 寄給被測節點的一封信（body 與 expects_reply 兩邊完全相同）。 */
export function buildSend(node, agent, body, replyTag = '並行試跑對照') {
  return { to_node: node, to_agent: agent, body, expects_reply: true, from_agent: replyTag }
}

/**
 * 收回覆：sent＝{ [信件id]: 節點 }。輪詢 inbox，reply_to 對得上的就記下並 ack；
 * 每個節點收到第一封後再等 settleMs 收「拆分的後續」與「重複回」；全部節點都有回且各自安靜了，或超過 timeoutMs 就結束。
 * api(action, body?) 與 sleep、now 可注入（測試用）。回傳 { [節點]: { sentAt, replies:[{id,from_agent,body,t}] } }
 */
export async function collect({ api, sent, sentAt, timeoutMs, settleMs, pollMs, sleep, now }) {
  const out = {}
  for (const node of new Set(Object.values(sent))) out[node] = { sentAt, replies: [] }
  const seen = new Set()
  const deadline = sentAt + timeoutMs
  for (;;) {
    const { messages = [] } = (await api('inbox')) || {}
    const ackIds = []
    for (const m of messages) {
      const node = sent[m.reply_to]
      if (!node || seen.has(m.id)) continue
      seen.add(m.id)
      out[node].replies.push({ id: m.id, from_agent: m.from_agent ?? null, from_node: m.from_node ?? null, body: String(m.body ?? ''), t: now() })
      ackIds.push(m.id)
    }
    if (ackIds.length) await api('ack', { ids: ackIds })
    const t = now()
    const quiet = Object.values(out).every(r => r.replies.length > 0 && t - r.replies[r.replies.length - 1].t >= settleMs)
    if (quiet || t >= deadline) return out
    await sleep(pollMs)
  }
}

/** 一個節點的結構摘要（不含內容）。 */
export function summarize(r) {
  const replies = r?.replies ?? []
  const bodies = replies.map(x => x.body.trim())
  return {
    replied: replies.length > 0,
    count: replies.length,
    senders: [...new Set(replies.map(x => x.from_agent ?? '(無)'))].sort(),
    duplicate: new Set(bodies).size < bodies.length,
    firstMs: replies.length ? replies[0].t - r.sentAt : null,
  }
}

/** 耗時算同量級：差 20 秒以內，或比值不超過 3 倍。 */
export function sameScale(x, y) {
  if (x == null || y == null) return false
  return Math.abs(x - y) <= 20_000 || Math.max(x, y) / Math.max(1, Math.min(x, y)) <= 3
}

/** 兩邊結構比對，回傳 { ok, diffs[] }。 */
export function compareSummaries(x, y) {
  const diffs = []
  if (x.replied !== y.replied) diffs.push(`有沒有回不同（${x.replied ? '有' : '無'} / ${y.replied ? '有' : '無'}）`)
  if (x.replied && y.replied) {
    if (x.count !== y.count) diffs.push(`回覆封數不同（${x.count} / ${y.count}）`)
    if (x.senders.join('|') !== y.senders.join('|')) diffs.push(`寄件人顯示名不同（${x.senders.join('、')} / ${y.senders.join('、')}）`)
    if (!sameScale(x.firstMs, y.firstMs)) diffs.push(`耗時差太多（${fmtMs(x.firstMs)} / ${fmtMs(y.firstMs)}）`)
  }
  if (x.duplicate) diffs.push('A 邊有內容完全相同的重複回')
  if (y.duplicate) diffs.push('B 邊有內容完全相同的重複回')
  return { ok: diffs.length === 0, diffs }
}

const fmtMs = ms => (ms == null ? '-' : `${(ms / 1000).toFixed(1)}秒`)

/** 輸出對照表（純文字）。rows：[{ q, a, b, result }] */
export function renderTable(rows, { a, b }) {
  const head = ['題', `${a}：回/封/耗時/寄件人`, `${b}：回/封/耗時/寄件人`, '結果']
  const cell = s => `${s.replied ? '有' : '無'}/${s.count}/${fmtMs(s.firstMs)}/${s.senders.join('、') || '-'}`
  const lines = [head.join(' | '), head.map(() => '---').join(' | ')]
  rows.forEach((r, i) => lines.push([i + 1, cell(r.a), cell(r.b), r.result.ok ? '一致' : '不一致：' + r.result.diffs.join('；')].join(' | ')))
  const bad = rows.filter(r => !r.result.ok).length
  lines.push('', `共 ${rows.length} 題，一致 ${rows.length - bad}，不一致 ${bad}`)
  return lines.join('\n')
}

export function loadQuestions(file) {
  if (!file) return DEFAULT_QUESTIONS
  const v = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(v) || !v.length || v.some(x => typeof x !== 'string' || !x.trim())) throw new Error('題目檔要是非空的字串陣列（JSON）')
  return v
}

function makeApi(url, key) {
  const base = url.replace(/\/+$/, '')
  return async (action, body) => {
    const res = await fetch(`${base}?action=${action}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-relay-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`${action} 失敗：HTTP ${res.status} ${data?.error ?? ''}`.trim())
    return data
  }
}

/** 跑完整對照。回傳 rows。 */
export async function runCompare(o, { api, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, log = console.log } = {}) {
  const questions = loadQuestions(o.questions)
  const rows = []
  for (let round = 0; round < o.rounds; round++) {
    for (const q of questions) {
      const sent = {}
      const sentAt = now()
      for (const node of [o.a, o.b]) {
        const r = await api('send', buildSend(node, o.agent, q))
        if (!r?.id) throw new Error(`寄給 ${node} 沒拿到信件編號`)
        sent[r.id] = node
      }
      log(`已寄出第 ${rows.length + 1} 題給 ${o.a}、${o.b}，等回覆…`)
      const got = await collect({ api, sent, sentAt, timeoutMs: o.timeoutMs, settleMs: o.settleMs, pollMs: o.pollMs, sleep, now })
      const sa = summarize(got[o.a]), sb = summarize(got[o.b])
      rows.push({ q, a: sa, b: sb, result: compareSummaries(sa, sb) })
    }
  }
  return rows
}

async function main() {
  let o
  try { o = parseArgs(process.argv.slice(2)) } catch (e) { console.error(e.message); return 2 }
  let questions
  try { questions = loadQuestions(o.questions) } catch (e) { console.error(e.message); return 2 }
  if (o.dryRun) {
    console.log(`（--dry-run：不連網路）寄件節點 ${o.tester}，對象 ${o.a} 與 ${o.b}，收件成員 ${o.agent}，共 ${questions.length * o.rounds} 題`)
    questions.forEach((q, i) => console.log(`${i + 1}. ${q}`))
    console.log(`金鑰檔（不讀）：${o.keyFile || defaultKeyFile(o.tester)}`)
    return 0
  }
  const keyFile = o.keyFile || defaultKeyFile(o.tester)
  let key
  try { key = fs.readFileSync(keyFile, 'utf8').trim() } catch { console.error(`讀不到寄件節點金鑰檔：${keyFile}`); return 2 }
  const rows = await runCompare(o, { api: makeApi(o.url, key) })
  console.log(renderTable(rows, o))
  return rows.every(r => r.result.ok) ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(c => { process.exitCode = c }, e => { console.error(`錯誤：${e.message}`); process.exitCode = 2 })
}
