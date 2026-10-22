#!/usr/bin/env node
// asn-room：本機 Claude 視窗主動查自己所在的群組（只讀，不經收發室、不經任何模型）。
//   node room.mjs --rooms                              列出我（節點~視窗名）在的群組、新訊息數、最後一則
//   node room.mjs --room-read <群組id|群組名> [--last 20 | --since <seq>] [--json]
// 身分跟 send.mjs／recv.mjs 同一套（identity.mjs）：視窗名由父行程鏈／環境變數備援認出，不能自填；不是成員就被擋（仲介回 403）。
// 只讀：呼叫 room_read 一律帶 since（不帶 since 仲介會把已讀推進），所以不動後端已讀位置，也不動機器橋的轉交游標。
// 「新訊息數」用本機記錄（~/.irori-relay/machine-<節點>/room-seen.json，每次 --room-read 讀到哪記到哪），含自己發的。
// exit code：1 用法、2 認不出視窗、3 不是成員／找不到群組、4 後端錯誤。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE_URL, Fail, HOME_DIR, findCaller, machineNode, readMachineKey } from './identity.mjs'
import { bodyWithNotes, normalizeAttachments } from './attach-format.mjs'

const MAX_LAST = 200
const USAGE = `用法：
  node room.mjs --rooms                                       列出我在的群組與新訊息數
  node room.mjs --room-read <群組id|群組名> [--last N | --since SEQ] [--json]
    --last N     最近 N 則（預設 20，最多 ${MAX_LAST}）
    --since SEQ  第 SEQ 則之後的（最多 ${MAX_LAST} 則）
    --json       每則一行 JSON（seq/from/from_name/trust/at/mentions/body）
只讀、不改已讀；身分（節點~視窗名）自動判定，不能自填。`

export function parseArgs(argv) {
  const a = {}
  const int = (k, v) => { if (!/^\d{1,9}$/.test(v ?? '')) throw new Fail(1, `${k} 要是非負整數\n${USAGE}`); return Number(v) }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const need = () => { if (i + 1 >= argv.length) throw new Fail(1, `${k} 缺少參數\n${USAGE}`); return argv[++i] }
    if (k === '--rooms') a.rooms = true
    else if (k === '--room-read') a.read = need()
    else if (k === '--last') a.last = int(k, need())
    else if (k === '--since') a.since = int(k, need())
    else if (k === '--json') a.json = true
    else if (k === '--help' || k === '-h') a.help = true
    else throw new Fail(1, `不認得的參數 ${k}\n${USAGE}`)
  }
  if (a.help) return a
  if (!a.rooms === (a.read === undefined)) throw new Fail(1, `--rooms 與 --room-read 要二選一\n${USAGE}`)
  if (a.rooms && (a.last !== undefined || a.since !== undefined || a.json)) throw new Fail(1, `--last／--since／--json 只用在 --room-read\n${USAGE}`)
  if (a.last !== undefined && a.since !== undefined) throw new Fail(1, `--last 與 --since 只能擇一\n${USAGE}`)
  if (a.last !== undefined && (a.last < 1 || a.last > MAX_LAST)) throw new Fail(1, `--last 要在 1～${MAX_LAST}`)
  return a
}

async function call(key, query) {
  const res = await fetch(`${BASE_URL}?action=${query}`, { headers: { 'x-relay-key': key }, signal: AbortSignal.timeout(20_000) })
  const text = await res.text(); let data = null
  try { data = JSON.parse(text) } catch {}
  if (res.status === 403) throw new Fail(3, `被擋：不是這個群組的成員（${data?.error ?? 'forbidden'}）`)
  if (res.status === 404) throw new Fail(3, '找不到這個群組')
  if (!res.ok) throw new Fail(4, `${query.split('&')[0]} HTTP ${res.status} ${data?.error ?? ''}`.trim())
  return data
}

const seenFile = node => path.join(HOME_DIR, `machine-${node}`, 'room-seen.json')
function readSeen(node) { try { return JSON.parse(fs.readFileSync(seenFile(node), 'utf8')) || {} } catch { return {} } }
function writeSeen(node, seen) {
  const f = seenFile(node)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const tmp = `${f}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(seen)); fs.renameSync(tmp, f)
}

const oneLine = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }
const fromText = m => m.from_name || (m.from === '~owner' ? '主人' : String(m.from ?? '').replace(/~/g, '/'))
export function formatMessage(m) {
  const at = m.at ? new Date(m.at).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' }) : ''
  const body = bodyWithNotes(String(m.body ?? '').replace(/\r\n/g, '\n'), m.attachments).split('\n').join('\n    ')
  return `#${m.seq} ${at} ${fromText(m)}（${m.trust ?? ''}）：\n    ${body}`
}

export async function main(argv, out = line => process.stdout.write(line + '\n')) {
  const a = parseArgs(argv)
  if (a.help) { console.log(USAGE); return 0 }
  const node = machineNode()
  const key = readMachineKey(node)
  const me = findCaller('查群組')
  const myKey = `${node}~${me.name}`
  const { rooms = [] } = await call(key, 'room_list')
  const mine = rooms.filter(r => (r.mine ?? []).some(x => x.member === myKey))
  const seen = readSeen(node)
  const seenOf = r => Math.max(Number(seen[`${r.id}|${myKey}`]) || 0, Number((r.mine ?? []).find(x => x.member === myKey)?.read_seq) || 0)

  if (a.rooms) {
    if (!mine.length) { out(`（${myKey} 目前不在任何群組）`); return 0 }
    for (const r of mine) {
      const fresh = Math.max(0, (Number(r.last_seq) || 0) - seenOf(r))
      const last = r.last_body ? `　最後：${r.last_from_name ?? ''}：${oneLine(r.last_body, 60)}` : ''
      out(`${r.id}　${r.name}　共 ${r.last_seq ?? 0} 則，新訊息 ${fresh} 則${last}`)
    }
    out(`看內容：node ${process.argv[1] ?? 'room.mjs'} --room-read <群組id> --last 20`)
    return 0
  }

  const want = a.read.trim()
  const room = mine.find(r => r.id === want) ?? mine.find(r => String(r.name).toLowerCase() === want.toLowerCase())
  if (!room) throw new Fail(3, `找不到「${want}」或你（${myKey}）不在這個群組；用 --rooms 看你在的群組`)
  const lastSeq = Number(room.last_seq) || 0
  const n = a.since !== undefined ? MAX_LAST : a.last ?? 20
  const since = a.since !== undefined ? a.since : Math.max(0, lastSeq - n)
  // 一定帶 since：仲介在沒有 since 時會把已讀推進
  const res = await call(key, `room_read&room=${encodeURIComponent(room.id)}&as_agent=${encodeURIComponent(me.name)}&since=${since}&limit=${n}`)
  const msgs = (res?.messages ?? []).filter(m => m.seq > since).sort((x, y) => x.seq - y.seq)
  if (!a.json) out(`[群組 ${room.name}]（${room.id}）第 ${since + 1}～${msgs.at(-1)?.seq ?? since} 則，共 ${res?.last_seq ?? lastSeq} 則`)
  for (const m of msgs) {
    out(a.json ? JSON.stringify({ seq: m.seq, from: m.from, from_name: m.from_name ?? null, trust: m.trust ?? null, at: m.at ?? null, mentions: m.mentions ?? [], body: bodyWithNotes(m.body, m.attachments), ...(normalizeAttachments(m.attachments).length ? { attachments: normalizeAttachments(m.attachments) } : {}) }) : formatMessage(m))
  }
  if (!a.json && !msgs.length) out('（沒有訊息）')
  const top = msgs.at(-1)?.seq
  if (top && top > (Number(seen[`${room.id}|${myKey}`]) || 0)) { seen[`${room.id}|${myKey}`] = top; try { writeSeen(node, seen) } catch {} }
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(c => { process.exitCode = c }, e => {
    console.error(e instanceof Fail ? e.message : `錯誤：${e.message}`)
    process.exitCode = e instanceof Fail ? e.code : 4
  })
}
