// Irori relay machine bridge (收發室橋).
// 橋只依「轉接器介面」運作（engines/；Claude Code 是第一個轉接器，介面見 README「轉接器介面」）：
// - roster: every 60 s 轉接器 listWindows（Claude：`claude agents --json`）-> relay `roster`
// - inbox: Realtime bell + 2 min poll -> 轉接器 deliver（Claude：收發室 worker，claude -p，只有 ListAgents/SendMessage）
//   -> SendMessage 給本機視窗 -> 等回覆（onReply）-> relay send (reply_to) back to the sender
// No private Claude Code protocol is used; everything goes through public CLI flags and the public SendMessage tool.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pickFallbackAgent, fallbackNote } from './pick-fallback.mjs'
import { contextText, createRooms, parseMember, roomText, roomUuid, NO_REPLY_RE as ROOM_NO_REPLY_RE } from './rooms.mjs'
import { NO_REPLY_TIP, mailHead, parseSendHead, wantsReply } from './mail-format.mjs'
import { createLauncher } from './launcher.mjs'
import { loadEngines } from './engines/index.mjs'
import { selfRecvAlive } from './self-recv.mjs'
import { sentMarkName } from './sent-mark.mjs'
import { snapshot, loadState, saveAtomic } from './pending-store.mjs'
import { checkAndUpdate, gitRunner, killTree, orphansOf, readyToRestart } from './self-update.mjs'
import { processTable } from './engines/claude-identity.mjs'
import { fileURLToPath } from 'node:url'

const NODE_ID = (process.env.IRORI_RELAY_ID || 'H').trim()
const BASE_URL = (process.env.IRORI_RELAY_URL || 'https://hwtahctsgjcemtwzlvnq.supabase.co/functions/v1/irori-relay').replace(/\/+$/, '')
const HOME_DIR = path.join(os.homedir(), '.irori-relay')
const WORK_DIR = path.join(HOME_DIR, `machine-${NODE_ID}`)
const MAILBOX_NAME = process.env.IRORI_MAILBOX_NAME || `${NODE_ID}-收發室`
const DEFAULT_AGENT = process.env.IRORI_RELAY_DEFAULT_AGENT || 'H-工頭-2'
const EXTRA_ALLOW = (process.env.IRORI_RELAY_ALLOW || '').split(',').map(s => s.trim()).filter(Boolean)
const POLL_MS = Number(process.env.IRORI_RELAY_POLL_MS || 120_000)
const ROSTER_MS = Number(process.env.IRORI_ROSTER_MS || 60_000)
const HEARTBEAT_MS = 25_000
const MAX_BACKOFF_MS = 30_000
const REPLY_TIMEOUT_MS = Number(process.env.IRORI_REPLY_TIMEOUT_MS || 600_000)
const NOTICE_WINDOW_MS = Number(process.env.IRORI_NOREPLY_WINDOW_MS || 1_800_000)   // 同一寄件人＋同一收件視窗，這段時間內只報一次「沒有回覆」
// 逾時之後的處理：遲到回覆保留期／筆數上限；對方忙碌時延後通知（閒下來後的寬限、總上限）
const LATE_KEEP_MS = Number(process.env.IRORI_LATE_KEEP_MS || 86_400_000)
const LATE_MAX = Number(process.env.IRORI_LATE_MAX || 200)
const BUSY_GRACE_MS = Number(process.env.IRORI_BUSY_GRACE_MS || 120_000)
const BUSY_MAX_MS = Number(process.env.IRORI_BUSY_MAX_MS || 3_600_000)
const BUSY_STATUS_RE = new RegExp(process.env.IRORI_BUSY_STATUS_RE || '^(busy|working|running)$', 'i')
const TICK_MS = Number(process.env.IRORI_BRIDGE_TICK_MS || 5_000)
const FORWARD_TIMEOUT_MS = Number(process.env.IRORI_FORWARD_TIMEOUT_MS || 120_000)   // 收發室多久沒回報 SENT 就算轉交逾時
const LOG_FILE = process.env.IRORI_RELAY_LOG || path.join(WORK_DIR, 'bridge.log')
// 自己更新：多久到 origin/main 看一次 relay/machine/ 有沒有新版（0＝關掉）；有新版就拉、收尾、結束，run-bridge.ps1 會用新版重啟
// 指向別的 relay（測試的假伺服器）時預設關掉，測試起的橋絕不會去拉真的 repo
const SELF_UPDATE_MS = Number(process.env.IRORI_SELF_UPDATE_MS ?? (process.env.IRORI_RELAY_URL ? 0 : 600_000))
const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

fs.mkdirSync(WORK_DIR, { recursive: true })
const log = msg => {
  const line = `${new Date().toISOString()} ${msg}`
  console.error(line)
  try { fs.appendFileSync(LOG_FILE, line + '\n') } catch {}
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

function readSecret(env, file) {
  const v = (process.env[env] || '').trim()
  if (v) return v
  try { return fs.readFileSync(path.join(HOME_DIR, file), 'utf8').trim() } catch { return '' }
}
const KEY = readSecret('IRORI_RELAY_KEY', `${NODE_ID}.key`)
const ANON_KEY = readSecret('IRORI_RELAY_ANON_KEY', 'anon.key')
if (!KEY) { console.error(`no relay key (${path.join(HOME_DIR, NODE_ID + '.key')})`); process.exit(2) }

async function api(action, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE_URL}?action=${action}`, {
    method,
    headers: { 'x-relay-key': KEY, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch {}
  if (!res.ok) { const e = new Error(`${action} HTTP ${res.status} ${data?.error ?? ''}`.trim()); e.status = res.status; throw e }
  return data
}

// ---- 本機視窗名單（轉接器 listWindows；每個引擎各自列自己的視窗）-----------------------------------
// 橋只認轉接器介面（engines/，見 README「轉接器介面」），不知道 Claude／Codex 的細節。
let engines = []     // IRORI_ENGINES 載入的轉接器（預設只有 claude）
let agents = []      // 所有引擎列出的全部 session（含非互動式）
let roster = []      // 給人用的視窗（可轉交名單）；每筆帶 engine 欄位
const engineById = id => engines.find(e => e.id === id)
const windowOf = name => roster.find(a => a.name === name) ?? agents.find(a => a.name === name)
const engineOfWindow = name => engineById(windowOf(name)?.engine) ?? engines[0]
// 名單上顯示的引擎名：轉接器可用 engine_label 另外標示（例如 acp 轉接器的 Gemini 工作者回報 gemini）；路由仍依 engine（轉接器代號）
const engineLabelOf = w => w?.engine_label ?? w?.engine
const activityOf = w => (engineById(w.engine) ?? engines[0]).activityOf(w)
const perEngine = new Map()   // engine id -> { all, windows }（最近一次成功的結果）
let rosterWarned = false
let rosterOk = false   // 第一次成功取得本機 session 清單前，群組訊息先不處理（避免把視窗誤判成不可轉交而跳過）
async function refreshRoster() {
  let any = false
  for (const e of engines) {
    const r = await e.listWindows()
    if (r) { perEngine.set(e.id, r); any = true }
  }
  if (!any) return
  agents = engines.flatMap(e => perEngine.get(e.id)?.all ?? [])
  const firstRoster = !rosterOk
  rosterOk = true
  roster = engines.flatMap(e => perEngine.get(e.id)?.windows ?? [])
  if (firstRoster) void pullRoomsGuarded()
  try {
    // engine 欄位：仲介的 roster 端點只取 name／status／cwd_label（多餘欄位直接忽略，不會 400），舊仲介安全
    await api('roster', { method: 'POST', body: { agents: roster.map(a => ({ name: a.name, status: a.status, cwd_label: a.cwd_label, engine: engineLabelOf(a) })), launcher: launcher.summary() } })
    rosterWarned = false
  } catch (e) {
    if (!rosterWarned) { log(`roster post failed: ${e.message} (will keep trying quietly)`); rosterWarned = true }
  }
}
const onlineNames = () => new Set(agents.filter(a => a.name && a.name !== MAILBOX_NAME).map(a => a.name))
const forwardable = name => roster.some(a => a.name === name) || (EXTRA_ALLOW.includes(name) && onlineNames().has(name))


// ---- mail state --------------------------------------------------------------------------------
const seen = new Set()        // acked mail ids (dedupe)
let restartSince = null, lastUpdateNote = ''   // 自己更新：拉到新版的時間（之後不收新信、等著重啟）
// 對應表有變動就存 WORK_DIR/pending.json（原子寫入、不含信件內文）；橋重啟後載回，遲到／對不上的回覆才不會因重啟被丟掉
const PENDING_FILE = path.join(WORK_DIR, 'pending.json')
let lastSaved = ''
let persistFailed = false
function persist() {
  const snap = snapshot(pending, lastRequester)
  const text = JSON.stringify(snap)
  if (text === lastSaved) return
  try { saveAtomic(PENDING_FILE, snap); lastSaved = text; persistFailed = false }
  catch (e) { if (!persistFailed) { persistFailed = true; log(`pending.json save failed: ${e.message}`) } }
}
class PendingMap extends Map {
  set(k, v) { const r = super.set(k, v); persist(); return r }
  delete(k) { const r = super.delete(k); persist(); return r }
}
const pending = new PendingMap()   // mail id -> {mail, target, state(forwarding|waiting|notified|done), t0, t, replied, notifiedAt}
const lastRequester = {}           // 收件視窗 -> {from_node, from_agent, mail_id, t}：最近一次交辦它的寄件人（對不上回覆時的轉寄對象）
{
  const st = loadState(PENDING_FILE, Date.now(), LATE_KEEP_MS)
  if (st.error) log(`pending.json unreadable, ignored: ${st.error}`)
  for (const [id, p] of st.pending) Map.prototype.set.call(pending, id, p)
  Object.assign(lastRequester, st.lastRequester)
  const n = st.pending.filter(([, p]) => p.state === 'notified').length
  if (st.pending.length || Object.keys(st.lastRequester).length || st.dropped)
    log(`pending restored: ${st.pending.length} (waiting ${st.pending.length - n}, notified ${n}), lastRequester ${Object.keys(st.lastRequester).length}, expired/invalid dropped ${st.dropped}`)
}
const noticed = new Map()     // 寄件人|收件視窗 -> {t, skipped}（逾時通知合併用）
// 要不要計時看信件的 expects_reply 欄位（寄件人明說；判斷在 mail-format.mjs 的 wantsReply）：true／false 就只看欄位，
// 欄位是 null（舊版寄件工具、舊信）才退回看內文的「（不需回覆）」「[no-reply]」標記——過渡期相容，之後拿掉。
// 寄件人是任何節點的收發室（<節點>-收發室）：系統信，照常轉交但不計時、不互相寄通知
const isMailboxSender = m => String(m?.from_agent ?? '').endsWith('收發室')
const selfHandled = new Set() // mail ids already logged as left to the window's own recv
const unrouted = new Set()   // mail ids already logged as waiting for the default agent

// 來信抬頭（mailHead，mail-format.mjs）：…id=<id> engine=<引擎> reply=yes|no|?（?＝舊信沒有 expects_reply 欄位）

// expectsReply（選填 true／false）：視窗代寄回信時寄件人明說的「要不要等回信」；系統通知與沒有明說的轉寄不帶，欄位就是 null
async function sendBack(p, body, fromAgent, expectsReply) {
  try {
    await api('send', { method: 'POST', body: { to_node: p.mail.from_node, to_agent: p.mail.from_agent || undefined, body, reply_to: p.mail.id, from_agent: fromAgent || MAILBOX_NAME, ...(typeof expectsReply === 'boolean' ? { expects_reply: expectsReply } : {}) } })
    return true
  } catch (e) { log(`send back failed id=${p.mail.id}: ${e.message}`); return false }
}
async function ackIds(ids) {
  if (!ids.length) return
  try { await api('ack', { method: 'POST', body: { ids } }); ids.forEach(i => seen.add(i)) } catch (e) { log(`ack failed: ${e.message}`) }
}

async function onSent(id) {
  const p = pending.get(id)
  if (!p || p.state !== 'forwarding') return
  p.state = 'waiting'
  persist()
  if (p.room) { log(`forwarded room=${p.room.id} #${p.room.seq} -> ${p.target}`); p.t = Date.now(); return }
  if (p.noReply) { pending.delete(id); log(`forwarded id=${id} -> ${p.target} (no-reply mail, no timer)`); await ackIds([id]); return }
  log(`forwarded id=${id} -> ${p.target} (${Date.now() - p.t0}ms)`)
  p.t = Date.now()
  await ackIds([id])
}
async function onFail(id, reason) {
  const p = pending.get(id)
  if (!p || p.state === 'done') return
  p.state = 'done'
  log(`forward failed id=${id}: ${reason}`)
  if (p.room) { pending.delete(id); return }   // 群組訊息：只記 log，不回群組
  if (isMailboxSender(p.mail)) log(`forward failure notice to mailbox sender ${p.mail.from_node}/${p.mail.from_agent} not sent id=${id}`)
  else await sendBack(p, `[收發室] 轉交給 ${p.target} 失敗：${reason || '原因不明'}`)
  await ackIds([id])
  pending.delete(id)
}
// 對不上任何來信的回覆：該視窗 24 小時內有最近一次交辦它的寄件人，就轉給他；沒有才丟棄（log 寫清楚）
async function forwardUnmatched(from, text, expectsReply) {
  const lr = lastRequester[from]
  if (!lr || Date.now() - lr.t > LATE_KEEP_MS) { log(`unmatched reply from ${from} (${text.length} chars) dropped: no pending mail and no requester within ${Math.round(LATE_KEEP_MS / 3600000)}h`); return }
  const ok = await sendBack({ mail: { id: lr.mail_id, from_node: lr.from_node, from_agent: lr.from_agent } }, `（收發室：這則回覆對不上特定來信，依最近一次交辦轉給你）\n${text}`, from, expectsReply)
  log(`unmatched reply from ${from} (${text.length} chars) -> last requester ${lr.from_node}/${lr.from_agent} reply_to=${lr.mail_id} sent=${ok}`)
}
// 視窗主動寄信（10/04 小良哥：收發室也要能代寄）：傳給收發室的訊息第一行寫
//   [RELAY 寄信] to=<節點>[/<視窗>] [re=<信件id>] reply=yes|no   （「[RELAY 回信]」同義；re 與 reply 順序不拘）
// 有 re＝回那一封（照回信流程）；沒有 re＝寄一封新信，寄件人是這個視窗（from-name 由 Claude Code 標記，視窗無法冒名）。
// reply 【必填】：yes＝寄件視窗在等回信（收發室對方那邊會計時）、no＝只是告知；寄出時當 expects_reply 欄位送給後端，內文不動。
// 沒寫（或寫錯）就不寄，用 tellWindow 通知寄件視窗補上（解析在 mail-format.mjs 的 parseSendHead）
async function sendNew(from, h) {
  if (!h.body) { log(`new mail from ${from} to ${h.to_node} dropped: empty body`); return }
  try {
    const r = await api('send', { method: 'POST', body: { to_node: h.to_node, to_agent: h.to_agent, body: h.body, from_agent: from, expects_reply: h.reply === 'yes' } })
    log(`new mail from ${from} -> ${h.to_node}/${h.to_agent ?? ''} id=${r?.id ?? '?'} sent=true reply=${h.reply}`)
  } catch (e) { log(`new mail from ${from} -> ${h.to_node} failed: ${e.message}`) }
}
// 代寄抬頭少了 reply=yes|no：不寄，log 記下，並把原因經轉接器 deliver 回給寄件視窗（和來信同一條路；亂數 id 不在 pending，結果回報會被忽略）
function refuseSend(from, h) {
  log(`new mail from ${from} to ${h.to_node} refused: no reply=yes|no in [RELAY 寄信] head (not sent)`)
  tellWindow(from, `[收發室] 你傳給收發室的代寄信沒有寄出：第一行 [RELAY 寄信] to=… 少了 reply=yes 或 reply=no。等對方回信就寫 reply=yes、只是告知就寫 reply=no（回信 re=<id> 也一樣要寫），補上後請重傳一次。（這是系統通知，不用回覆。）內文開頭：${h.body.replace(/\s+/g, ' ').slice(0, 40)}`)
}
// 通知信的編號／視窗記一下（TTL 10 分鐘）：視窗若回了這則通知，那則回覆不是給任何人的，丟掉而不是轉給它的最近交辦者
const NOTICE_TTL_MS = 600_000
const noticeIds = new Map()       // 通知信編號 -> 時間
const noticeWindows = new Map()   // 視窗名 -> 最近一則通知的時間
const fresh = t => t != null && Date.now() - t < NOTICE_TTL_MS
function tellWindow(name, text) {
  const id = crypto.randomUUID()
  for (const [k, t] of noticeIds) if (!fresh(t)) noticeIds.delete(k)
  for (const [k, t] of noticeWindows) if (!fresh(t)) noticeWindows.delete(k)
  noticeIds.set(id, Date.now()); noticeWindows.set(name, Date.now())
  try { engineOfWindow(name).deliver({ id, to: name, text }) }
  catch (e) { log(`cannot tell window ${name}: ${e.message}`) }
}

// mailId（選用）：轉接器知道這則回覆是回哪一封時帶上（acp 工作者同時有好幾封在排隊，不能靠先進先出猜）
async function onReply(from, text, mailId) {
  const head = parseSendHead(text)
  let expectsReply   // 代寄回信（re=）時寄件人明說的 true／false；其他回覆不帶（null）
  if (head && !head.re && !mailId) { if (head.reply) await sendNew(from, head); else refuseSend(from, head); return }
  if (head?.re) {
    if (!head.reply) { refuseSend(from, head); return }
    mailId = head.re; text = head.body || text; expectsReply = head.reply === 'yes'
  }
  const cands = [...pending.values()].filter(p => p.target === from && p.state !== 'forwarding')
  // 還在等的優先；沒有才輪到已通知過「沒回」、仍保留中的信（遲到的回覆，先進先出）
  const active = cands.filter(c => c.state !== 'notified')
  const byId = mailId ? cands.find(c => c.mail.id === mailId) : null
  const p = byId || active.find(c => !c.replied) || active[active.length - 1] || cands.find(c => c.state === 'notified')
  if (!p) {
    if (fresh(noticeIds.get(mailId)) || fresh(noticeWindows.get(from))) { noticeIds.delete(mailId); noticeWindows.delete(from); log(`reply from ${from} dropped: answer to a bridge notice (not forwarded)`); return }
    await forwardUnmatched(from, text, expectsReply); return
  }
  const late = p.state === 'notified'
  p.replied = true
  if (late) pending.delete(p.mail.id)   // 遲到的回覆寄回後就清掉
  if (p.room) {
    if (ROOM_NO_REPLY_RE.test(text)) { log(`room reply from ${from} room=${p.room.id} #${p.room.seq} marked no-reply: not posted`); return }
    const ok = await rooms.post(p.room.id, text, p.room.window || undefined)   // 節點本身是成員時以節點發言；視窗是成員時以 節點~視窗 發言
    log(`room reply from ${from} -> room=${p.room.id} #${p.room.seq} posted=${ok}`)
    return
  }
  const ok = await sendBack(p, late ? `（遲到的回覆：${p.target} 在收發室寄出「沒有回覆」通知之後才回）\n${text}` : text, from, expectsReply)
  log(`${late ? 'late ' : ''}reply from ${from} -> ${p.mail.from_node} id=${p.mail.id} sent=${ok} (${Date.now() - p.t0}ms total)`)
}

// reason：timeout（照常逾時）／window-closed（對方視窗已不在名單）／busy-idle-grace（忙完閒下來後寬限到了）／busy-max（忙碌延後到總上限）
async function noticeNoReply(p, now, reason) {
  const key = `${p.mail.from_node}/${p.mail.from_agent ?? ''}|${p.target}`
  const prev = noticed.get(key)
  if (prev && now - prev.t < NOTICE_WINDOW_MS) { prev.skipped++; log(`no-reply notice suppressed id=${p.mail.id} (${key})`); return }
  const more = prev?.skipped ? `；另有 ${prev.skipped} 封也還沒回` : ''
  noticed.set(key, { t: now, skipped: 0 })
  const mins = Math.max(1, Math.round((now - p.t) / 60000))
  // timeout 與 busy 兩種結尾多一句：只是告知的信別等回信（寄件時用 --no-reply／代寄寫 reply=no），就不會有這個提醒
  const text = reason === 'window-closed' ? `[收發室] 對方視窗「${p.target}」已關閉，沒有經收發室收到回覆${more}`
    : reason === 'timeout' ? `[收發室] ${Math.round(REPLY_TIMEOUT_MS / 60000)} 分鐘內沒有經收發室收到 ${p.target} 的回覆（對方若已另外回信可忽略）${more}。${NO_REPLY_TIP}`
    : `[收發室] ${p.target} 先前一直在忙，等了約 ${mins} 分鐘仍沒有經收發室收到回覆（對方若已另外回信可忽略）${more}。${NO_REPLY_TIP}`
  const ok = await sendBack(p, text)
  log(`no-reply notice sent id=${p.mail.id} (${key}) reason=${reason} sent=${ok}`)
}

const agentOf = name => agents.find(a => a.name === name)
const isBusy = a => !!a && BUSY_STATUS_RE.test(String(a.status ?? ''))

// 一封「超過等待時間還沒回」的信：決定現在寄通知、延後、還是不用寄
async function judgeTimeout(id, p, now) {
  if (p.replied) { pending.delete(id); return }
  if (repliedDirectly(id)) { pending.delete(id); log(`no-reply notice skipped id=${id}: ${p.target} replied directly (send.mjs --reply-to)`); return }
  if (sentToSender(p)) { pending.delete(id); log(`no-reply notice skipped id=${id}: ${p.target} sent mail to ${p.mail.from_node}/${p.mail.from_agent ?? ''} after forward`); return }
  const a = agentOf(p.target)
  let reason = 'timeout'
  if (!a && rosterOk) reason = 'window-closed'
  else if (a && isBusy(a)) {
    if (now - p.t < BUSY_MAX_MS) {
      if (!p.deferred) { p.deferred = true; log(`no-reply notice deferred id=${id}: ${p.target} is busy (status=${a.status})`) }
      p.idleSince = 0
      return
    }
    reason = 'busy-max'
  } else if (p.deferred) {
    if (!p.idleSince) { p.idleSince = now; return }
    if (now - p.idleSince < BUSY_GRACE_MS) return
    reason = 'busy-idle-grace'
  }
  // 決定要通知：信留著等遲到的回覆（先改 state，免得 await 期間下一輪又處理同一封）
  p.state = 'notified'; p.notifiedAt = now
  persist()
  evictNotified()
  await noticeNoReply(p, now, reason)
}
function evictNotified() {
  const list = [...pending.entries()].filter(([, p]) => p.state === 'notified').sort((a, b) => a[1].notifiedAt - b[1].notifiedAt)
  for (let k = 0; k < list.length - LATE_MAX; k++) { pending.delete(list[k][0]); log(`late-reply slot evicted id=${list[k][0]} (over ${LATE_MAX})`) }
}

setInterval(async () => {
  const now = Date.now()
  for (const [id, p] of pending) {
    if (p.state === 'forwarding' && now - p.t0 > FORWARD_TIMEOUT_MS) {
      p.state = 'done'
      if (p.room) { log(`room forward timeout id=${id} -> ${p.target}`); pending.delete(id); continue }
      // 收發室沒回報，但對方已經回了這封（或已寄信給原寄件人）＝其實有轉到：不寄「轉交逾時」，免得寄件人以為對方沒收到
      if (repliedDirectly(id) || sentToSender(p)) { log(`forward unconfirmed but ${p.target} already replied id=${id}: no timeout notice`); await ackIds([id]); pending.delete(id); continue }
      if (isMailboxSender(p.mail)) log(`forward timeout notice to mailbox sender not sent id=${id}`)
      else await sendBack(p, `[收發室] 轉交給 ${p.target} 逾時（收發室沒有完成轉交）`)
      await ackIds([id]); pending.delete(id)
    } else if (p.state === 'waiting' && now - p.t > REPLY_TIMEOUT_MS) {
      if (p.room) pending.delete(id)
      else await judgeTimeout(id, p, now)
    } else if (p.state === 'notified' && now - p.notifiedAt > LATE_KEEP_MS) {
      pending.delete(id); log(`late-reply slot expired id=${id}`)
    }
  }
  for (const [t, r] of Object.entries(lastRequester)) if (now - r.t > LATE_KEEP_MS) delete lastRequester[t]
  persist()
  pruneReplied(now)
}, TICK_MS)

// 視窗用 send.mjs --reply-to 直接回了這封（send.mjs 在 WORK_DIR/replied/<信件id> 留的記號）；記號留一天
const REPLIED_DIR = path.join(WORK_DIR, 'replied')
const repliedDirectly = id => fs.existsSync(path.join(REPLIED_DIR, id))
// send.mjs 每次寄給某節點／視窗也留記號（WORK_DIR/sent/<sha1(視窗|節點|視窗名)>，內容＝寄出時間 ms）：
// 轉交之後，收件視窗曾寄信給原寄件人（同節點＋同視窗，或只寄給該節點）就視為已回覆
const SENT_DIR = path.join(WORK_DIR, 'sent')
const sentToSender = p => {
  const from = p.mail.from_node, agent = p.mail.from_agent ?? ''
  for (const to of new Set([agent, ''])) {
    try { if (Number(fs.readFileSync(path.join(SENT_DIR, sentMarkName(p.target, from, to)), 'utf8')) >= p.t0) return true } catch {}
  }
  return false
}
let prunedAt = 0
function pruneReplied(now) {
  if (now - prunedAt < 3_600_000) return
  prunedAt = now
  for (const dir of [REPLIED_DIR, SENT_DIR]) {
    try { for (const f of fs.readdirSync(dir)) { const fp = path.join(dir, f); if (now - fs.statSync(fp).mtimeMs > 86_400_000) fs.unlinkSync(fp) } } catch {}
  }
}

// ---- inbox -------------------------------------------------------------------------------------
// ---- 遠端開視窗（launcher.mjs；指令只來自本機 ~/.irori-relay/launcher.json）--------------------------
// 視窗出現後：馬上刷新名單（手機看得到、也才轉交得到），有第一句話就當成 owner 的來信經收發室送進去（id＝launch id）
// send：轉接器要主動寄信時用（acp 工作者的授權詢問、登入通知）；from_agent 預設是收發室名稱
engines = await loadEngines({ log, workDir: WORK_DIR, mailboxName: MAILBOX_NAME, send: m => api('send', { method: 'POST', body: { to_node: m.to_node, to_agent: m.to_agent || undefined, body: m.body, reply_to: m.reply_to || undefined, from_agent: m.from_agent || MAILBOX_NAME } }) })
// 開視窗：launcher.json 的 profile 可寫 "engine": "codex" 指定用哪個轉接器開；沒寫就用第一個宣告 openWindow 的轉接器。
// 都沒有就不提供遠端開視窗（名單回報 launcher: null）
const openEngines = engines.filter(e => e.capabilities().openWindow && e.openWindow)
const openEngineFor = id => (id ? openEngines.find(e => e.id === id) : openEngines[0])
const launcher = !openEngines.length ? { summary: () => null, pull: async () => {}, current: () => null } : createLauncher({
  api, log, workDir: WORK_DIR, configPath: process.env.IRORI_LAUNCHER_FILE || path.join(HOME_DIR, 'launcher.json'),
  listNames: async () => {
    const sets = await Promise.all(engines.map(e => e.listNames()))
    return sets.some(x => x) ? new Set(sets.flatMap(x => (x ? [...x] : []))) : null
  },
  start: s => {
    const e = openEngineFor(s.engine)
    if (!e) throw new Error(`沒有載入「${s.engine}」轉接器（IRORI_ENGINES）`)
    return e.openWindow(s)
  },
  envFilter: (env, engineId) => (openEngineFor(engineId) ?? openEngines[0]).childEnv(env),
  onLaunched: async l => {
    await refreshRoster()
    if (l.first_message) await handleMail({ id: l.id, from_node: l.requested_by, from_agent: null, to_agent: l.name, trust: 'owner', body: l.first_message })
  },
  ...(process.env.IRORI_LAUNCH_CONFIRM_MS ? { confirmMs: Number(process.env.IRORI_LAUNCH_CONFIRM_MS), pollMs: 200 } : {}),
})

let pulling = false, again = false
async function handleMail(m) {
  // 這個視窗自己在收信（recv.mjs --watch 的心跳在 90 秒內且 pid 活著）：橋不轉、不 ack，留給視窗自己拉；心跳過期就照舊轉交，不會漏信
  if (m.to_agent && engineOfWindow(m.to_agent).capabilities().selfRecv && selfRecvAlive(WORK_DIR, m.to_agent)) {
    if (!selfHandled.has(m.id)) { selfHandled.add(m.id); log(`id=${m.id} to=${m.to_agent} window receives by itself (recv heartbeat): bridge skips`) }
    return
  }
  let target = m.to_agent || DEFAULT_AGENT
  let note = ''
  if (!m.to_agent && !onlineNames().has(DEFAULT_AGENT)) {
    // 預設收件視窗不在線：改交給最近有活動的互動式 session，都沒有才留在 inbox
    const fb = pickFallbackAgent(roster, activityOf)
    if (!fb) {
      if (!unrouted.has(m.id)) { unrouted.add(m.id); log(`id=${m.id} has no to_agent and ${DEFAULT_AGENT} is offline and no interactive session online: left in inbox`) }
      return
    }
    target = fb.name
    note = fallbackNote(DEFAULT_AGENT, fb.name)
    log(`id=${m.id} has no to_agent and ${DEFAULT_AGENT} is offline: fallback to most recently active session ${fb.name}`)
  }
  const p = { mail: m, target, state: 'forwarding', t0: Date.now(), t: Date.now(), replied: false, noReply: !wantsReply(m.expects_reply, m.body) || isMailboxSender(m) }
  if (!forwardable(target)) {
    const names = roster.map(a => a.name).join('、') || '(無)'
    p.state = 'done'
    if (isMailboxSender(m)) log(`id=${m.id} target ${target} not found; notice to mailbox sender not sent`)
    else await sendBack(p, `[收發室] 找不到名叫「${target}」的 session（目前可達：${names}）`)
    await ackIds([m.id])
    return
  }
  pending.set(m.id, p)
  if (!p.noReply) { lastRequester[target] = { from_node: m.from_node, from_agent: m.from_agent ?? '', mail_id: m.id, t: Date.now() }; persist() }
  try {
    const eng = engineOfWindow(target)
    eng.deliver({ id: m.id, to: target, text: `${mailHead(m, engineLabelOf(windowOf(target)) ?? eng.id)}\n${note ? note + '\n' : ''}${m.body}` })
    log(`handed id=${m.id} from=${m.from_node}/${m.from_agent ?? ''} to=${target}`)
  } catch (e) {
    pending.delete(m.id); log(`cannot hand id=${m.id}: ${e.message} (left in inbox)`)
  }
}
// ---- 群組轉交（for_me 由後端決定，橋只轉 for_me=true）----------------------------------------------
const rooms = createRooms({ api, workDir: WORK_DIR, log })
async function handleRoomMsg(room, member, msg) {
  if (!rosterOk) return false
  const { window } = parseMember(member)
  let target, note = ''
  if (!window) {
    target = DEFAULT_AGENT
    if (!onlineNames().has(DEFAULT_AGENT)) {
      const fb = pickFallbackAgent(roster, activityOf)
      if (!fb) { log(`room=${room.id} #${msg.seq} default agent offline and no session online: kept (cursor not advanced)`); return false }
      target = fb.name
      note = fallbackNote(DEFAULT_AGENT, fb.name)
    }
  } else {
    target = window
    if (!forwardable(target)) { log(`room=${room.id} #${msg.seq} window ${target} not forwardable: skipped`); return true }
  }
  const id = roomUuid(room.id, msg.seq, member)
  if (pending.has(id)) return true
  const p = { mail: { id, from_node: '', from_agent: '' }, room: { id: room.id, seq: msg.seq, window }, target, state: 'forwarding', t0: Date.now(), t: Date.now(), replied: false, noReply: false }
  pending.set(id, p)
  const prev = await rooms.context(room.id, member, msg.seq)   // 前面最近 5 則當上下文（只讀；失敗就不附）
  try {
    engineOfWindow(target).deliver({ id, to: target, text: `${roomText(room, msg)}${note ? '\n' + note : ''}\n${contextText(room, prev)}` })
    log(`handed room=${room.id} #${msg.seq} member=${member} to=${target}`)
    return true
  } catch (e) {
    pending.delete(id); log(`cannot hand room=${room.id} #${msg.seq}: ${e.message} (cursor not advanced)`); return false
  }
}
let roomsPulling = false, roomsAgain = false
async function pullRoomsGuarded() {
  if (roomsPulling) { roomsAgain = true; return }
  roomsPulling = true
  try { do { roomsAgain = false; await rooms.pullRooms(handleRoomMsg) } while (roomsAgain) }
  catch (e) { log(`rooms pull failed: ${e.message}`) } finally { roomsPulling = false }
}
async function pull(why) {
  if (restartSince) return   // 已經拉到新版、等著重啟：不再收新信，留在信箱給重啟後的橋
  void pullRoomsGuarded()
  void launcher.pull()
  if (pulling) { again = true; return }
  pulling = true
  try {
    do {
      again = false
      const { messages = [] } = await api('inbox')
      const dup = []
      for (const m of messages) {
        if (seen.has(m.id)) { dup.push(m.id); continue }
        if (pending.has(m.id)) continue
        await handleMail(m)
      }
      await ackIds(dup)
    } while (again)
  } catch (e) { log(`pull failed (${why}): ${e.message}`) } finally { pulling = false }
}

// ---- Realtime bell (same phoenix-channels dance as relay/channel) -------------------------------
let backoff = 1000, ws = null, hb = null
function connectBell(topic) {
  if (!ANON_KEY) { log('no anon key: doorbell off, polling only'); return }
  const url = `wss://${new URL(BASE_URL).host}/realtime/v1/websocket?apikey=${encodeURIComponent(ANON_KEY)}&vsn=1.0.0`
  let ref = 0, closed = false
  const send = (t, event, payload = {}) => ws.send(JSON.stringify({ topic: t, event, payload, ref: String(++ref), join_ref: '1' }))
  const die = why => {
    if (closed) return
    closed = true; clearInterval(hb)
    log(`doorbell down (${why}); retry in ${backoff}ms`)
    setTimeout(() => connectBell(topic), backoff)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }
  try { ws = new WebSocket(url) } catch (e) { die(String(e)); return }
  ws.onopen = () => {
    send('realtime:' + topic, 'phx_join', { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, postgres_changes: [], private: false } })
    hb = setInterval(() => { try { send('phoenix', 'heartbeat') } catch {} }, HEARTBEAT_MS)
  }
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data) } catch { return }
    if (m.event === 'phx_reply' && m.topic === 'realtime:' + topic) {
      if (m.payload?.status === 'ok') { backoff = 1000; log('doorbell joined'); void pull('join') }
    } else if (m.event === 'broadcast' && m.payload?.event === 'bell') void pull('bell')
    else if (m.event === 'phx_error' || m.event === 'phx_close') { try { ws.close() } catch {}; die(m.event) }
  }
  ws.onerror = () => die('error')
  ws.onclose = () => die('close')
}

// ---- main ----------------------------------------------------------------------------------------
const shutdown = () => { for (const e of engines) { try { e.stop() } catch {} }; setTimeout(() => process.exit(0), 500) }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
process.on('uncaughtException', e => log(`uncaught: ${e.stack ?? e}`))
process.on('unhandledRejection', e => log(`unhandled: ${e?.stack ?? e}`))

// single instance per node: a live pid in bridge.pid means another bridge is running
const LOCK = path.join(WORK_DIR, 'bridge.pid')
try {
  const old = Number(fs.readFileSync(LOCK, 'utf8'))
  if (old && old !== process.pid) { try { process.kill(old, 0); console.error(`another bridge is running (pid ${old})`); process.exit(3) } catch (e) { if (e.code === 'EPERM') process.exit(3) } }
} catch {}
fs.writeFileSync(LOCK, String(process.pid))
// 上一個橋留下的孤兒（收發室、工作者）先收掉，免得兩組同時收信（見 self-update.mjs）
const LAST = path.join(WORK_DIR, 'bridge.last')
try {
  const lastPid = Number(fs.readFileSync(LAST, 'utf8')) || 0
  const orphans = lastPid ? orphansOf(processTable(), lastPid, process.pid) : []
  for (const pid of orphans) log(`killed orphan pid=${pid} left by previous bridge pid=${lastPid}: ${await killTree(pid) ? 'ok' : 'failed'}`)
} catch (e) { if (e.code !== 'ENOENT') log(`orphan check failed: ${e.message}`) }
fs.writeFileSync(LAST, String(process.pid))
process.on('exit', () => { try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.unlinkSync(LOCK) } catch {} })

log(`bridge starting node=${NODE_ID} mailbox=${MAILBOX_NAME}`)
for (const e of engines) e.start({ onSent, onFail, onReply })
void refreshRoster()
setInterval(() => void refreshRoster(), ROSTER_MS)
for (let wait = 2000;;) {
  try { const w = await api('whoami'); log(`whoami node=${w.node}`); connectBell(w.bell_topic); break }
  catch (e) { log(`whoami failed: ${e.message}`); await sleep(wait); wait = Math.min(wait * 2, MAX_BACKOFF_MS) }
}
void pull('startup')
setInterval(() => void pull('poll'), POLL_MS)

// ---- 自己更新、自己重啟 ----------------------------------------------------------------------------
async function selfUpdate() {
  if (restartSince) return
  const r = await checkAndUpdate(gitRunner(REPO_DIR))
  if (r.action === 'updated') {
    restartSince = Date.now()
    log(`self-update ${r.from} -> ${r.to} (${r.changed.join(', ')}): stop taking mail, restart when nothing is forwarding`)
  } else if (r.action !== 'none' && r.reason !== lastUpdateNote) log(`self-update ${r.action}: ${r.reason}`)
  lastUpdateNote = r.reason
}
if (SELF_UPDATE_MS > 0) {
  setTimeout(() => void selfUpdate(), 30_000)
  setInterval(() => void selfUpdate(), SELF_UPDATE_MS)
  setInterval(() => {
    if (!restartSince) return
    const ok = readyToRestart([...pending.values()].map(p => p.state), restartSince, Date.now())
    if (!ok.ok) return
    log(`self-update restart (${ok.reason})`)
    persist()
    shutdown()
  }, TICK_MS)
}
