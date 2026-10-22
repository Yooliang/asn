// 之後移出本 repo（#14 R8，D11）：本橋服務 Aegis 主機，那台部署還在用，移出步驟見 docs/design/ONBOARDING.md 第 7.5 節。移出前不要刪、不要改名。
// Irori relay Aegis 轉接橋（Linux / Aegis 主機）。
// 用一把仲介節點金鑰收信；每封信 = 一次 POST <aegis>/api/v1/agent-chat/ask（to_agent 當成員 slug），把 answer 用 reply_to 寄回。
// 只有白名單（IRORI_AEGIS_ALLOW）內的成員能被問；不開 claude -p、不需要 claude CLI。
import { envGet } from './env-compat.mjs'
import { pickAnon } from './anon.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCore } from './relay-core.mjs'
import { createLog } from './safe-log.mjs'
import { createRooms, parseMember, roomText } from './rooms.mjs'

const NODE_ID = (envGet(process.env, 'RELAY_ID') || 'AEGIS').trim()
const BASE_URL = envGet(process.env, 'RELAY_URL') || 'https://etccgmkrosbzpltudlgt.supabase.co/functions/v1/relay'
import { HOME_DIR, locateHome } from './home.mjs'
const WORK_DIR = path.join(HOME_DIR, `aegis-${NODE_ID}`)
const AEGIS_URL = (process.env.IRORI_AEGIS_URL || 'http://127.0.0.1:8899').replace(/\/+$/, '')
const FROM_MEMBER = process.env.IRORI_AEGIS_FROM_MEMBER || 'xi-xu'
const ALLOW = (process.env.IRORI_AEGIS_ALLOW || '').split(',').map(s => s.trim()).filter(Boolean)
const SELF_MEMBER = (process.env.IRORI_AEGIS_SELF || 'xi-xu').trim()   // 希緒自己：不列進名單、也不能被問
const DEFAULT_MEMBER = (process.env.IRORI_AEGIS_DEFAULT || 'aegis').trim()   // 沒有 to_agent 的信交給它（要在白名單內）
const ASK_TIMEOUT_MS = Number(process.env.IRORI_AEGIS_TIMEOUT_MS || 300_000)
const RETRY_MS = Number(process.env.IRORI_AEGIS_RETRY_MS || 60_000)
const POLL_MS = Number(envGet(process.env, 'RELAY_POLL_MS') || 120_000)
const ROSTER_MS = Number(envGet(process.env, 'ROSTER_MS') || 60_000)
const LOG_FILE = envGet(process.env, 'RELAY_LOG') || path.join(WORK_DIR, 'bridge.log')

fs.mkdirSync(WORK_DIR, { recursive: true })
// 主控台寫不出去也不會進無限迴圈、檔案有上限會輪替（2026-10-13 bridge.log 長到 181 GB 的事故，見 safe-log.mjs）
const log = createLog(LOG_FILE)
const sleep = ms => new Promise(r => setTimeout(r, ms))

function readSecret(env, file) {
  const v = (envGet(process.env, env) || '').trim()
  if (v) return v
  try { return fs.readFileSync(locateHome(file), 'utf8').trim() } catch { return '' }
}
const KEY = readSecret('RELAY_KEY', `${NODE_ID}.key`)
const ANON_KEY = pickAnon(BASE_URL, [envGet(process.env, 'RELAY_ANON_KEY'), readSecret('', 'anon.key')])   // 內建新後台的 anon；殘留的舊專案 anon.key 會被跳過
if (!KEY) { console.error(`no relay key (${path.join(HOME_DIR, NODE_ID + '.key')})`); process.exit(2) }

const core = createCore({ baseUrl: BASE_URL, key: KEY, anonKey: ANON_KEY, log, workDir: WORK_DIR })
const { api } = core

// ---- Aegis ------------------------------------------------------------------------------------
// 回 {http, data}；網路錯誤／逾時回 {http: 0, error}
async function aegisAsk(target, question) {
  try {
    const res = await fetch(`${AEGIS_URL}/api/v1/agent-chat/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target, question, from_member: FROM_MEMBER, stream: false }),
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    })
    let data = null
    try { data = await res.json() } catch {}
    return { http: res.status, data }
  } catch (e) { return { http: 0, error: e.message } }
}
const askFailed = r => r.http === 0 || r.http >= 500 || (r.http >= 200 && r.http < 300 && r.data?.status === 'error')

let memberNames = new Map()   // slug -> 中文名
let membersLoaded = null     // 第一次載入成員表的 promise（收信前先等它，才能把中文名轉成 slug）
// to_agent 可以是 slug 或中文名；回 slug（對不上就原樣回傳，交給白名單判斷）
function resolveSlug(t) {
  if (memberNames.has(t)) return t
  for (const [slug, name] of memberNames) if (name && name === t) return slug
  return t
}
// 回信／名單上的名字：和 roster 回報的一致（中文名優先，沒有才用 slug），收件人才會看到同一個視窗回信
const displayName = slug => memberNames.get(slug) || slug
async function refreshMembers() {
  try {
    const res = await fetch(`${AEGIS_URL}/api/v1/members?scope=all`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return
    const d = await res.json()
    const list = Array.isArray(d) ? d : (d.members ?? d.items ?? d.data ?? [])
    memberNames = new Map(list.filter(x => x?.slug).map(x => [x.slug, x.name ?? x.display_name ?? x.member_name ?? '']))
  } catch (e) { log(`members fetch failed: ${e.message}`) }
}

// ---- roster：只回報白名單成員 ---------------------------------------------------------------------
let rosterWarned = false
async function refreshRoster() {
  await refreshMembers()
  // name＝中文名（沒有才用 slug）、cwd_label＝slug
  const agents = ALLOW.filter(slug => slug !== SELF_MEMBER).map(slug => ({ name: displayName(slug), status: 'idle', cwd_label: slug }))
  try {
    await api('roster', { method: 'POST', body: { agents } })
    rosterWarned = false
  } catch (e) {
    if (!rosterWarned) { log(`roster post failed: ${e.message} (will keep trying quietly)`); rosterWarned = true }
  }
}

// ---- 信件處理 -----------------------------------------------------------------------------------
const seen = new Set()       // 已 ack（去重）
const inflight = new Set()   // 處理中（避免重複補拉時重複問）

async function sendBack(m, body, fromAgent) {
  try {
    await api('send', { method: 'POST', body: { to_node: m.from_node, to_agent: m.from_agent || undefined, body, reply_to: m.id, ...(fromAgent ? { from_agent: fromAgent } : {}) } })
    return true
  } catch (e) { log(`send back failed id=${m.id}: ${e.message}`); return false }
}
async function ackIds(ids) {
  if (!ids.length) return
  try { await api('ack', { method: 'POST', body: { ids } }); ids.forEach(i => seen.add(i)) } catch (e) { log(`ack failed: ${e.message}`) }
}
// 回覆寄出成功才 ack；寄失敗就留在 inbox，下次補拉再來
async function replyAndAck(m, body, fromAgent) {
  if (await sendBack(m, body, fromAgent)) await ackIds([m.id])
}

async function handleMail(m) {
  await membersLoaded
  const target = (m.to_agent || '').trim()
  const who = `from=${m.from_node}/${m.from_agent ?? ''}`
  // 沒指定收件人 → 預設成員（在白名單才算數）
  const slug = target ? resolveSlug(target) : (ALLOW.includes(DEFAULT_MEMBER) ? DEFAULT_MEMBER : '')
  if (!slug) {
    log(`id=${m.id} ${who} no to_agent: asked to specify`)
    const list = ALLOW.map(s => memberNames.get(s) ? `${s}（${memberNames.get(s)}）` : s).join('、') || '(目前沒有開放任何成員)'
    return replyAndAck(m, `[Aegis] 請指定要問的成員（to_agent）。目前開放聯絡：${list}`)
  }
  if (slug === SELF_MEMBER) {
    log(`id=${m.id} ${who} to=${slug} blocked (self)`)
    return replyAndAck(m, '[Aegis] 這是希緒自己，不能自己問自己')
  }
  if (!ALLOW.includes(slug)) {
    log(`id=${m.id} ${who} to=${slug} blocked (not in allowlist)`)
    return replyAndAck(m, `[Aegis] 這位成員沒有開放聯絡（${slug}）`)
  }
  const question = `這是透過仲介轉來的信：from=${m.from_node}/${m.from_agent ?? ''} trust=${m.trust}\n${m.body}`
  const t0 = Date.now()
  let r = await aegisAsk(slug, question)
  if (r.http === 404) {
    log(`id=${m.id} ${who} to=${slug} aegis 404`)
    return replyAndAck(m, `[Aegis] 查無此成員（${slug}）`)
  }
  if (askFailed(r)) {
    log(`id=${m.id} to=${slug} ask failed (http=${r.http} status=${r.data?.status ?? r.error ?? ''}); retry in ${RETRY_MS}ms`)
    await sleep(RETRY_MS)
    r = await aegisAsk(slug, question)
    if (r.http === 404) return replyAndAck(m, `[Aegis] 查無此成員（${slug}）`)
    if (askFailed(r)) {
      log(`id=${m.id} to=${slug} ask failed again (http=${r.http}): busy reply`)
      return replyAndAck(m, '[Aegis] 對方忙線中，請稍後再問', displayName(slug))
    }
  }
  const status = r.data?.status
  const answer = String(r.data?.answer ?? '')
  const from = displayName(slug)   // 不用 Aegis 回的 member（是拼音 slug），否則回信會像另一個視窗寄的
  log(`id=${m.id} ${who} to=${slug} status=${status} (${Date.now() - t0}ms)`)
  if (r.http >= 200 && r.http < 300 && status === 'success') return replyAndAck(m, answer || '(空回覆)', from)
  return replyAndAck(m, `[Aegis] 對方回報狀態 ${status ?? `HTTP ${r.http}`}${answer ? `：${answer}` : ''}`, from)
}

// ---- 群組（被點名／主人發問才問；白名單外略過）--------------------------------------------------
const rooms = createRooms({ api, workDir: WORK_DIR, log })
async function handleRoomMsg(room, member, msg) {
  await membersLoaded
  const { window } = parseMember(member)
  const slug = window ? resolveSlug(window) : DEFAULT_MEMBER
  if (slug === SELF_MEMBER || !ALLOW.includes(slug)) { log(`room=${room.id} #${msg.seq} member=${member} (${slug}) not in allowlist: skipped`); return true }
  const r = await aegisAsk(slug, roomText(room, msg))
  const answer = String(r.data?.answer ?? '')
  if (askFailed(r) || r.http < 200 || r.http >= 300 || r.data?.status !== 'success' || !answer) {
    log(`room=${room.id} #${msg.seq} to=${slug} ask failed (http=${r.http} status=${r.data?.status ?? r.error ?? ''}): not posted`)
    return true
  }
  await rooms.post(room.id, answer, window ? (memberNames.get(slug) || slug) : undefined)   // 節點本身是成員時以節點發言
  return true
}
let roomsPulling = false, roomsAgain = false
async function pullRoomsGuarded() {
  if (roomsPulling) { roomsAgain = true; return }
  roomsPulling = true
  try { do { roomsAgain = false; await rooms.pullRooms(handleRoomMsg) } while (roomsAgain) }
  catch (e) { log(`rooms pull failed: ${e.message}`) } finally { roomsPulling = false }
}

let pulling = false, again = false
async function pull(why) {
  void pullRoomsGuarded()
  if (pulling) { again = true; return }
  pulling = true
  try {
    do {
      again = false
      const { messages = [] } = await api('inbox')
      const dup = []
      for (const m of messages) {
        if (seen.has(m.id)) { dup.push(m.id); continue }
        if (inflight.has(m.id)) continue
        inflight.add(m.id)
        void handleMail(m).catch(e => log(`handle failed id=${m.id}: ${e.stack ?? e}`)).finally(() => inflight.delete(m.id))
      }
      await ackIds(dup)
    } while (again)
  } catch (e) { log(`pull failed (${why}): ${e.message}`) } finally { pulling = false }
}

// ---- main ---------------------------------------------------------------------------------------
process.on('SIGINT', () => process.exit(0)); process.on('SIGTERM', () => process.exit(0))
process.on('uncaughtException', e => log(`uncaught: ${e.stack ?? e}`))
process.on('unhandledRejection', e => log(`unhandled: ${e?.stack ?? e}`))
core.singleInstance()

log(`aegis bridge starting node=${NODE_ID} aegis=${AEGIS_URL} allow=[${ALLOW.join(',')}]${ALLOW.length ? '' : ' (empty: everything blocked)'}`)
membersLoaded = refreshMembers()
void refreshRoster()
setInterval(() => void refreshRoster(), ROSTER_MS)
for (let wait = 2000;;) {
  try { const w = await api('whoami'); log(`whoami node=${w.node}`); core.connectBell(w.bell_topic, why => void pull(why)); break }
  catch (e) { log(`whoami failed: ${e.message}`); await sleep(wait); wait = Math.min(wait * 2, 30_000) }
}
void pull('startup')
setInterval(() => void pull('poll'), POLL_MS)
