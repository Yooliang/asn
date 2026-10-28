// 0.2 H4 後續（#457）：從手機關閉「這台機器橋用 tmux 開的夥伴」。Rust 橋的遠端管理（partner_ops.rs）走 partner_op_pending／partner_op_result，
// 機器橋原本完全沒有這條路；這裡只做最小的一塊：op=close，其他 op 一律回「不支援」（也一定回報，手機不會等到逾時）。
//
// 守門（每條都有測試）：
// 1. 只關這台橋自己開的：開 tmux 視窗的當下把 session 名記進 machine-<ID>/tmux-opened.json；關的時候名字必須在記錄裡，
//    而且 tmux has-session -t =asn-<名字> 精確比對確實存在才動手。使用者自己開的 asn- 開頭 session 不在記錄裡，不關。
// 2. 結束只用 tmux kill-session -t =asn-<名字>，不用 pid 去殺程序，也不用名稱或命令列字串找程序。
// 3. 這台沒有開放遠端開視窗與管理（啟動設定不可用，例如 launcher.json 寫了 remote_launch:false）就不動；動手前再驗一次。
// 4. 收發室視窗不動。
// 5. 記錄檔原子寫入；讀不懂（壞掉）就一律不關並照實說；每輪順手把已經不存在的 session 從記錄裡拿掉。
import fs from 'node:fs'
import path from 'node:path'
import { findBin, runTmux, sessionName } from './tmux-window.mjs'

export const UNSUPPORTED = '這類夥伴不支援這個操作'
export const CONSENT_OFF = '這台電腦沒有開啟「允許遠端開視窗與管理視窗」'
export const PROTECTED = 'ASN 通知與 ASN 自己的視窗不能操作'
export const NOT_OURS = '這個視窗不是這台機器橋用 tmux 開的，請在那台電腦自己關'
export const REGISTRY_BAD = '這台記錄 tmux 視窗的檔案讀不懂，為了安全不關任何視窗'
export const NO_TMUX_FOUND = '找不到 tmux，沒辦法關閉'
export const GONE = '視窗已經不在了'
export const CLOSED = '已關閉'
export const DETAIL_MAX = 500
const PRUNE_EVERY_MS = 60_000

/** 讀記錄檔：不存在＝空；讀不懂（不是 JSON、形狀不對）＝ { ok: false } */
export function readRegistry(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) { return e?.code === 'ENOENT' ? { ok: true, sessions: {} } : { ok: false } }
  try {
    const j = JSON.parse(text.replace(/^﻿/, ''))
    if (!j || typeof j !== 'object' || Array.isArray(j) || !j.sessions || typeof j.sessions !== 'object' || Array.isArray(j.sessions)) return { ok: false }
    const sessions = {}
    for (const [s, v] of Object.entries(j.sessions)) if (v && typeof v.name === 'string' && v.name && s === sessionName(v.name)) sessions[s] = { name: v.name, at: Number(v.at) || 0 }
    return { ok: true, sessions }
  } catch { return { ok: false } }
}

/** 原子寫入（先寫暫存檔再改名） */
export function writeRegistry(file, sessions) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, sessions }, null, 2) + '\n')
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* 沒寫成就沒有暫存檔 */ }
    throw e
  }
}

/** 開 tmux 視窗成功後記下 session 名。記錄檔壞掉就重新開始（舊的記不得就變成遠端關不掉，是安全的方向） */
export function recordOpened(file, name, now = Date.now()) {
  const cur = readRegistry(file)
  const sessions = cur.ok ? cur.sessions : {}
  sessions[sessionName(name)] = { name, at: now }
  writeRegistry(file, sessions)
}

const ok = detail => ({ status: 'ok', detail })
const failed = detail => ({ status: 'failed', detail })

// deps：api(action, opts)、log(msg)、file（記錄檔）、mailboxName、allowed()（這台現在開放遠端管理嗎）、
//       findTmux()（測試可換）、run(tmux, args, env)（測試換成假的 tmux）、now()
export function createTmuxPartners({ api, log, file, mailboxName, allowed, findTmux = () => findBin('tmux', process.env.PATH ?? ''), run = runTmux, now = Date.now }) {
  let off = false, warned = false, lastPrune = 0
  const seen = new Set()
  const inflight = new Set()

  const exists = async (tmux, s) => (await run(tmux, ['has-session', '-t', `=${s}`], process.env)).code === 0

  async function execute(op) {
    if (op.op !== 'close') return failed(UNSUPPORTED)
    if (!allowed()) return failed(CONSENT_OFF)
    if (op.name === mailboxName) return failed(PROTECTED)
    const reg = readRegistry(file)
    if (!reg.ok) return failed(REGISTRY_BAD)
    const s = sessionName(op.name)
    if (reg.sessions[s]?.name !== op.name) return failed(NOT_OURS)
    const tmux = findTmux()
    if (!tmux) return failed(NO_TMUX_FOUND)
    const drop = () => { const r = readRegistry(file); if (r.ok && r.sessions[s]) { delete r.sessions[s]; writeRegistry(file, r.sessions) } }
    if (!(await exists(tmux, s))) { drop(); return ok(GONE) }
    if (!allowed()) return failed(CONSENT_OFF)   // 動手前再驗一次
    const k = await run(tmux, ['kill-session', '-t', `=${s}`], process.env)
    if (await exists(tmux, s)) return failed(`tmux 沒有關掉它（結束碼 ${k.code}）`)
    drop()
    return ok(CLOSED)
  }

  async function finish(op, r) {
    log(`partner-op ${op.op} name=${op.name} by=${op.by || '手機'} -> ${r.status}: ${r.detail}`)
    try { await api('partner_op_result', { method: 'POST', body: { id: op.id, status: r.status, detail: r.detail.slice(0, DETAIL_MAX) } }) } catch (e) { log(`partner_op_result failed id=${op.id}: ${e.message}`) }
  }

  async function begin(o) {
    const op = { id: String(o?.id ?? '').trim(), name: String(o?.name ?? '').trim(), op: String(o?.op ?? '').trim(), by: String(o?.requested_by_label ?? '').trim().slice(0, 40) }
    if (!op.id || seen.has(op.id)) return
    seen.add(op.id)
    if (op.op !== 'close') return finish(op, failed(UNSUPPORTED))   // 不支援的操作不佔「處理中」
    const key = op.name.toLowerCase()
    if (inflight.has(key)) return finish(op, failed('這個視窗正在處理上一個操作，請稍後再試'))
    inflight.add(key)
    let r
    try { r = await execute(op) } catch (e) { r = failed(`處理失敗：${e.message}`) } finally { inflight.delete(key) }
    await finish(op, r)
  }

  // 每輪順手：記錄裡已經不存在的 session 拿掉（最多每分鐘一次；沒有記錄就不問 tmux；記錄壞了不動它）
  async function prune() {
    if (now() - lastPrune < PRUNE_EVERY_MS) return
    lastPrune = now()
    const reg = readRegistry(file)
    if (!reg.ok || !Object.keys(reg.sessions).length) return
    const tmux = findTmux()
    if (!tmux) return
    let changed = false
    for (const s of Object.keys(reg.sessions)) if (!(await exists(tmux, s))) { delete reg.sessions[s]; changed = true }
    if (changed) writeRegistry(file, reg.sessions)
  }

  /** 取走待辦並逐筆處理。後台沒有這個動作（404／400）就靜默停用到下次啟動 */
  async function pull() {
    if (off) return
    let v
    try { v = await api('partner_op_pending') } catch (e) {
      if (e?.status === 404 || e?.status === 400) { off = true; log('partner_op_pending not supported by backend (remote partner ops off until restart)') }
      else if (!warned) { warned = true; log(`partner_op_pending failed: ${e.message} (will keep trying quietly)`) }
      return
    }
    warned = false
    await Promise.all((Array.isArray(v?.ops) ? v.ops : []).map(begin))
    try { await prune() } catch (e) { log(`tmux-partners prune failed: ${e.message}`) }
  }

  return { pull, execute, prune }
}
