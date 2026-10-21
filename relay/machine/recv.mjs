#!/usr/bin/env node
// irori-recv：本機 Claude 視窗自己收仲介寄給它的信，不經收發室、不經任何模型。
//   node recv.mjs --once     拉一次，每封印一行 JSON 到 stdout、印完 ack，然後結束
//   node recv.mjs --watch    長駐：Realtime 門鈴＋輪詢；每封一行 JSON 到 stdout（給 Claude Code 的 Monitor 用）
// 只收「to_agent＝本視窗名」的信（視窗名由父行程鏈／環境變數備援認出，和 send.mjs 同一套，不能自填）；
// 寄給整台機器（沒指定視窗）的總機信不在這裡，仍由機器橋處理。回信用：node send.mjs --to <from_node>/<from_agent> --reply-to <id> --body "…" (--reply | --no-reply)
// --watch 會在 ~/.irori-relay/machine-<節點>/self-recv/<視窗名>.json 寫心跳；橋看到心跳就不再轉交這個視窗的信（心跳過期就照舊轉）。
// 每行 JSON：{id, trust, from_node, from_agent, to_agent, reply_to, created_at, expects_reply, body}。診斷訊息只走 stderr。
// expects_reply：寄件人明說要不要回信（true 要回、false 只是告知不用回、null＝舊信沒說）；回信用 send.mjs 時也要選 --reply／--no-reply。
// exit code：1 用法、2 認不出視窗、3 這個視窗已有另一個 recv --watch 在跑、4 後端錯誤。
import { pickAnon } from './anon.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE_URL, Fail, HOME_DIR, alivePid, findCaller, machineNode, readMachineKey } from './identity.mjs'
import { createCore } from './relay-core.mjs'
import { bodyWithNotes, normalizeAttachments } from './attach-format.mjs'
import { createPullWithRetry, parsePullBackoffMs } from './pull-retry.mjs'
import { HEARTBEAT_MS, clearHeartbeat, readHeartbeat, selfRecvAlive, writeHeartbeat } from './self-recv.mjs'

const POLL_MS = Number(process.env.IRORI_RECV_POLL_MS || 120_000)
const USAGE = `用法：
  node recv.mjs --once    拉一次、印出（每封一行 JSON）、ack 後結束
  node recv.mjs --watch   長駐收信（門鈴＋輪詢，每封一行 JSON 到 stdout；給 Monitor 用）
只收寄給本視窗名的信；回信用 send.mjs --reply-to <id>（再加 --reply 或 --no-reply 二選一）。`

export function parseArgs(argv) {
  const a = {}
  for (const k of argv) {
    if (k === '--once') a.once = true
    else if (k === '--watch') a.watch = true
    else if (k === '--help' || k === '-h') a.help = true
    else throw new Fail(1, `不認得的參數 ${k}\n${USAGE}`)
  }
  if (!a.help && !a.once === !a.watch) throw new Fail(1, `--once 與 --watch 要二選一\n${USAGE}`)
  return a
}

// 有附件（照片）時：body 後面多一行「〔照片〕檔名（…）下載：node "…/attach.mjs" --id <編號>」（外部資料，同內文），另有 attachments 欄位（不含縮圖）；沒附件的信完全不變
export const toLine = m => {
  const atts = normalizeAttachments(m.attachments)
  return JSON.stringify({
    id: m.id, trust: m.trust, from_node: m.from_node, from_agent: m.from_agent ?? null, to_agent: m.to_agent ?? null,
    reply_to: m.reply_to ?? null, created_at: m.created_at ?? null,
    expects_reply: typeof m.expects_reply === 'boolean' ? m.expects_reply : null,   // 寄件人明說要不要回信：true 要回、false 只是告知、null＝舊信沒說
    body: atts.length ? bodyWithNotes(m.body, atts) : m.body,
    ...(atts.length ? { attachments: atts } : {}),
  })
}

export async function main(argv, out = line => process.stdout.write(line + '\n')) {
  const a = parseArgs(argv)
  if (a.help) { console.log(USAGE); return 0 }
  const node = machineNode()
  const key = readMachineKey(node)
  const me = findCaller('收信')
  const workDir = path.join(HOME_DIR, `machine-${node}`)
  let anonKey = (process.env.IRORI_RELAY_ANON_KEY || '').trim()
  if (!anonKey) { try { anonKey = fs.readFileSync(path.join(HOME_DIR, 'anon.key'), 'utf8').trim() } catch {} }
  anonKey = pickAnon(BASE_URL, [anonKey])   // 沒有或是舊專案的就用內建
  const log = msg => console.error(`${new Date().toISOString()} recv[${me.name}] ${msg}`)
  const core = createCore({ baseUrl: BASE_URL, key, anonKey, log, workDir })
  const q = encodeURIComponent(me.name)
  const printed = new Set()   // 已印出但（可能）還沒 ack 成功的信：不重印，只重試 ack

  async function pullOnce() {
    const { messages = [] } = await core.api(`inbox&agent=${q}`)
    const ids = []
    for (const m of messages) {
      if (m.to_agent !== me.name) continue   // 後端已過濾；這裡再擋一次，不是寄給本視窗的絕不印、不 ack
      if (!printed.has(m.id)) { out(toLine(m)); printed.add(m.id) }
      ids.push(m.id)
    }
    if (ids.length) {
      await core.api(`ack&agent=${q}`, { method: 'POST', body: { ids } })
      ids.forEach(i => printed.delete(i))
    }
    return ids.length
  }

  if (a.once) {
    try { await pullOnce() } catch (e) { throw new Fail(4, `收信失敗：${e.message}`) }
    return 0
  }

  // --watch：同一視窗只留一個（另一個還活著就退出，避免兩個 Monitor 重複印）
  const hb = readHeartbeat(workDir, me.name)
  if (hb && hb.pid !== process.pid && selfRecvAlive(workDir, me.name)) throw new Fail(3, `視窗「${me.name}」已經有一個 recv --watch 在跑（pid ${hb.pid}）`)
  const beat = () => { try { writeHeartbeat(workDir, me.name) } catch (e) { log(`heartbeat failed: ${e.message}`) } }
  beat()
  const timers = [setInterval(beat, HEARTBEAT_MS)]
  const stop = () => { timers.forEach(clearInterval); clearHeartbeat(workDir, me.name); process.exit(0) }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  process.on('exit', () => clearHeartbeat(workDir, me.name))
  // 視窗本體不在了（Monitor 沒收乾淨）就自己結束，免得心跳一直亮著卻沒人看
  timers.push(setInterval(() => { if (!alivePid(me.pid)) { log('window gone: exit'); stop() } }, 10_000))

  const { pull } = createPullWithRetry({ pullOnce, log, backoffMs: parsePullBackoffMs(process.env) })
  let topic = null
  for (let wait = 2000; ; wait = Math.min(wait * 2, 30_000)) {
    try { topic = (await core.api('whoami')).bell_topic; break } catch (e) { log(`whoami failed: ${e.message}`); await core.sleep(wait) }
  }
  core.connectBell(topic, why => void pull(why))
  void pull('startup')
  timers.push(setInterval(() => void pull('poll'), POLL_MS))
  log(`watching node=${node} window=${me.name}`)
  return await new Promise(() => {})   // 長駐到被結束為止
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(c => { process.exitCode = c }, e => {
    console.error(e instanceof Fail ? e.message : `錯誤：${e.message}`)
    process.exitCode = e instanceof Fail ? e.code : 4
  })
}
