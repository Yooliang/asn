// 本機視窗身分的共用判定（send.mjs、recv.mjs 共用）：機器節點、父行程鏈／環境變數認出呼叫者的 claude 視窗、機器金鑰。
// 寄件／收件視窗名不能自填：一律由這裡從 ~/.claude/sessions 對照出來。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HOME_DIR = path.join(os.homedir(), '.irori-relay')
export const BASE_URL = (process.env.IRORI_RELAY_URL || 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/irori-relay').replace(/\/+$/, '')

export class Fail extends Error { constructor(code, msg) { super(msg); this.code = code } }

// 機器節點：IRORI_RELAY_ID → ~/.irori-relay/node → 橋正在跑的 machine-<ID> → 唯一有金鑰檔的 machine-<ID>
export function machineNode() {
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
export function processTable() {
  const txt = process.platform === 'win32'
    ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    : execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 20_000 }).replace(/^\s*(\d+)\s+(\d+)\s+/gm, '$1|$2|')
  const t = new Map()
  for (const line of txt.split(/\r?\n/)) { const m = line.trim().split('|'); if (m.length >= 2 && /^\d+$/.test(m[0])) t.set(Number(m[0]), { ppid: Number(m[1]), name: m[2] ?? '' }) }
  return t
}

export const sessionsDir = () => path.join(os.homedir(), '.claude', 'sessions')
export function readSession(pid) {
  try { const j = JSON.parse(fs.readFileSync(path.join(sessionsDir(), `${pid}.json`), 'utf8')); return Number(j.pid) === pid ? j : null } catch { return null }
}
export const alivePid = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

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
export function findCaller(what = '寄信') {
  const ev = inspectCaller()
  const hit = ev.viaChain ?? ev.viaEnv
  if (!hit) throw new Fail(2, `拒絕：找不到呼叫者所屬的 Claude 視窗（只有在 Claude 視窗裡執行才能${what}）${ev.tableError ? `；讀行程表失敗：${ev.tableError}` : ''}\n除錯：加 --whoami 看父行程鏈與 session 對照`)
  if (!hit.name) throw new Fail(2, `找到 claude 視窗（pid ${hit.pid}）但它沒有名字，無法當${what === '收信' ? '收件人' : '寄件人'}；請先 /rename`)
  return { pid: hit.pid, name: hit.name }
}

// 機器金鑰：IRORI_RELAY_KEY 優先，否則 ~/.irori-relay/<節點>.key（橋用的同一把）
export function readMachineKey(node) {
  let key = (process.env.IRORI_RELAY_KEY || '').trim()
  if (!key) { try { key = fs.readFileSync(path.join(HOME_DIR, `${node}.key`), 'utf8').trim() } catch {} }
  if (!key) throw new Fail(1, `找不到機器金鑰 ${path.join(HOME_DIR, node + '.key')}`)
  return key
}
