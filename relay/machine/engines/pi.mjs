// pi 轉接器（#456）：把「裝了 ASN 擴充的互動 pi」變成名單上可收信的視窗。對應 Rust 橋的 bridge/engines/pi.rs，檔案約定兩邊一致
// （另一半是 relay/pi-extension/ 的 inbox.mjs）。介面見 relay/machine/README.md「轉接器介面」。
//   名單 ＝ 讀 <使用者資料夾>/pi-windows/<sessionId>.json（擴充每 60 秒寫一次心跳）。只收：檔名＝sessionId、檔案不大、at 在有效期內、pid 還活著；
//           名字重複的後面加 -pid，免得一個名字對到兩個收件者。
//   投遞 ＝ 把信（橋已組好的全文）原子寫成 <使用者資料夾>/pi-inbox/<sessionId>/<信件編號>.json，寫成功就回報已轉交；擴充注入對話後把檔移到 done/。
//           同編號重投是覆蓋，不會變兩封。
//   回信 ＝ pi 自己用 asn_send（reply_to 帶編號）寄，橋不等回覆。
// 不開任何子程序、不碰金鑰。
import fs from 'node:fs'
import path from 'node:path'
import { resolveHome } from '../home.mjs'

export const WINDOW_MAX_AGE_MS = 5 * 60 * 1000       // 擴充每 60 秒寫一次；5 分鐘沒更新＝擴充停了或 pi 卡死
const WINDOW_MAX_BYTES = 16 * 1024
const NAME_MAX_CHARS = 40
export const MAIL_MAX_BYTES = 256 * 1024
export const INBOX_MAX_PENDING = 200
const SPOOL_KEEP_MS = 7 * 24 * 3600 * 1000           // 離線視窗的收件匣保留多久
const DEAD_WINDOW_KEEP_MS = 24 * 3600 * 1000         // 登記檔的 pid 已死多久後清掉
export const RENAME_EXT = 2                          // 擴充版本比這個小：名單上提醒更新（與 Rust 的 pi_control::RENAME_EXT 一致）
export const OLD_EXT_DETAIL = 'ASN 的 pi 擴充較舊，請更新'

export const windowsDir = home => path.join(home, 'pi-windows')
export const inboxDir = home => path.join(home, 'pi-inbox')

const validSid = s => typeof s === 'string' && s.length > 0 && s.length <= 128 && /^[A-Za-z0-9_-]+$/.test(s)
const cwdLabel = p => String(p ?? '').split(/[\\/]+/).filter(Boolean).pop() || ''
const cleanName = s => [...String(s).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[/\\]/g, '-').trim()].slice(0, NAME_MAX_CHARS).join('').trim()

/** 程序還活著嗎（沒有權限送訊號＝程序存在，只是不是自己的） */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' }
}

function modelLabel(v) {
  const clean = k => (typeof v[k] === 'string' ? [...v[k].trim()].filter(c => c >= ' ' && c !== '\x7f').join('') : '')
  const model = clean('model')
  if (!model) return undefined
  const provider = clean('provider')
  return provider && [...provider].length + 1 + [...model].length <= 60 ? `${provider}/${model}` : [...model].slice(0, 60).join('')
}

/** 一個登記檔 → 視窗；不合格回 null */
function parseWindow(file, stem, now, alive) {
  let v
  try {
    if (fs.statSync(file).size > WINDOW_MAX_BYTES) return null
    v = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch { return null }
  if (!v || v.sessionId !== stem || v.engine !== 'pi') return null
  const at = Number(v.at)
  if (!Number.isFinite(at) || Math.abs(now - at) > WINDOW_MAX_AGE_MS) return null
  const pid = Number(v.pid)
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return null
  const name = typeof v.name === 'string' ? cleanName(v.name) : ''
  if (!name) return null
  const cwd = typeof v.cwd === 'string' ? v.cwd : ''
  const w = { name, status: v.state === 'busy' ? 'busy' : 'idle', cwd, cwd_label: cwdLabel(cwd), engine: 'pi', pid, sessionId: stem, mod_loaded: true }
  if (!(Number(v.ext) >= RENAME_EXT)) w.detail = OLD_EXT_DETAIL
  const model = modelLabel(v)
  if (model) w.model = model
  return w
}

/** 讀所有有效的 pi 視窗。資料夾不存在＝沒有；名字重複的（依 sessionId 排序，先到先得）後者改名「名字-pid」 */
export function readWindows(dir, now = Date.now(), alive = pidAlive) {
  let names
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out = []
  for (const f of names) {
    const stem = f.endsWith('.json') ? f.slice(0, -5) : null
    if (!stem || !validSid(stem)) continue
    const w = parseWindow(path.join(dir, f), stem, now, alive)
    if (w) out.push(w)
  }
  out.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
  const taken = new Set()
  for (const w of out) {
    if (taken.has(w.name)) w.name = cleanName(`${w.name}-${w.pid}`)
    taken.add(w.name)
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.pid - b.pid))
}

/** 投遞一封信到某個視窗的收件匣（原子寫入）。同編號覆蓋（去重）；已在 done/ 的視為已處理，直接成功不再寫 */
export function writeInbox(home, sid, id, to, text, now = Date.now()) {
  if (!validSid(sid) || !validSid(id)) throw new Error('視窗或信件編號不合法')
  if (Buffer.byteLength(text) > MAIL_MAX_BYTES) throw new Error('信太大，pi 收件匣不收')
  const dir = path.join(inboxDir(home), sid)
  if (fs.existsSync(path.join(dir, 'done', `${id}.json`))) return
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, `${id}.json`)
  const pending = fs.readdirSync(dir).filter(n => n.endsWith('.json')).length
  if (pending >= INBOX_MAX_PENDING && !fs.existsSync(target)) throw new Error(`pi 收件匣已積 ${pending} 封未處理`)
  const tmp = path.join(dir, `${id}.json.${process.pid}.tmp`)
  try {
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, id, to, text, at: now }))
    fs.renameSync(tmp, target)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* 沒寫成就沒有暫存檔 */ }
    throw new Error(`寫入收件匣失敗：${e.message}`)
  }
}

/** 順手清理：登記檔 pid 已死且超過一天沒更新的刪掉；沒有對應登記檔、超過 7 天沒動的收件匣整個刪掉。回傳刪了幾項 */
export function cleanup(home, now = Date.now(), alive = pidAlive) {
  let n = 0
  const live = new Set()
  const wd = windowsDir(home)
  let names = []
  try { names = fs.readdirSync(wd) } catch { /* 沒有資料夾 */ }
  for (const f of names) {
    const stem = f.endsWith('.json') ? f.slice(0, -5) : null
    if (!stem || !validSid(stem)) continue
    let v = null
    try { v = JSON.parse(fs.readFileSync(path.join(wd, f), 'utf8')) } catch { /* 壞檔不動 */ }
    if (!v) continue
    const at = Number(v.at) || 0, pid = Number(v.pid) || 0
    if ((pid > 0 && alive(pid)) || now - at <= DEAD_WINDOW_KEEP_MS) live.add(stem)
    else { try { fs.unlinkSync(path.join(wd, f)); n++ } catch { /* 刪不掉下次再試 */ } }
  }
  const ib = inboxDir(home)
  let boxes = []
  try { boxes = fs.readdirSync(ib) } catch { /* 沒有資料夾 */ }
  for (const b of boxes) {
    if (!validSid(b) || live.has(b)) continue
    const p = path.join(ib, b)
    try {
      const st = fs.statSync(p)
      if (st.isDirectory() && now - st.mtimeMs > SPOOL_KEEP_MS) { fs.rmSync(p, { recursive: true, force: true }); n++ }
    } catch { /* 略過 */ }
  }
  return n
}

// ctx：{ log, workDir, mailboxName, env? }。deps（測試用）：home、now、alive
export function createEngine({ log, env = process.env, deps = {} }) {
  const home = deps.home ?? resolveHome({ env }).primary
  const now = deps.now ?? Date.now
  const alive = deps.alive ?? pidAlive
  let handlers = null
  const current = () => readWindows(windowsDir(home), now(), alive)
  return {
    id: 'pi',
    // 視窗自己用 asn_send 回信（不等回覆）；沒有 recv 心跳，也不靠活動時間挑代收視窗
    capabilities: () => ({ listWindows: true, deliver: true, openWindow: false, selfRecv: false, identity: false, fallbackByActivity: false }),
    start(h) { handlers = h },
    stop() {},
    async listWindows() {
      try { cleanup(home, now(), alive) } catch (e) { log(`pi: cleanup failed: ${e.message}`) }
      const windows = current()
      return { all: windows, windows }
    },
    async listNames() { return new Set(current().map(w => w.name)) },
    activityOf: () => 0,
    // 同步寫進收件匣；寫成功才回報已轉交（橋才 ack 並開始等回信）。視窗不在線或寫入失敗＝同步 throw，信留在信箱
    deliver({ id, to, text }) {
      const w = current().find(x => x.name === to)
      if (!w) throw new Error(`pi 視窗「${to}」不在線`)
      writeInbox(home, w.sessionId, id, to, text, now())
      log(`pi: mail id=${id} spooled for ${to}`)
      queueMicrotask(() => handlers?.onSent?.(id))
    },
  }
}
