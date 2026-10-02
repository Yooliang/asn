// 「視窗自己收信」心跳：recv.mjs --watch 跑著時，每 30 秒在 ~/.irori-relay/machine-<節點>/self-recv/<視窗名>.json 寫 {pid, name, t}。
// 機器橋轉交前檢查：心跳在 90 秒內、而且 pid 還活著 → 這個視窗自己在收，橋就不再經收發室轉它的信；心跳過期或 pid 死了 → 照舊轉交。
import fs from 'node:fs'
import path from 'node:path'

export const HEARTBEAT_MS = Number(process.env.IRORI_RECV_HEARTBEAT_MS || 30_000)
export const STALE_MS = Number(process.env.IRORI_RECV_STALE_MS || 90_000)

const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
export const selfRecvDir = workDir => path.join(workDir, 'self-recv')
export const heartbeatFile = (workDir, name) => path.join(selfRecvDir(workDir), `${String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')}.json`)

export function readHeartbeat(workDir, name) {
  try { return JSON.parse(fs.readFileSync(heartbeatFile(workDir, name), 'utf8')) } catch { return null }
}
export function writeHeartbeat(workDir, name, pid = process.pid, now = Date.now()) {
  fs.mkdirSync(selfRecvDir(workDir), { recursive: true })
  const file = heartbeatFile(workDir, name), tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ pid, name, t: now })); fs.renameSync(tmp, file)
}
export function clearHeartbeat(workDir, name, pid = process.pid) {
  try { if (readHeartbeat(workDir, name)?.pid === pid) fs.unlinkSync(heartbeatFile(workDir, name)) } catch {}
}
// 這個視窗現在有沒有自己在收信（供橋判斷）
export function selfRecvAlive(workDir, name, now = Date.now()) {
  const h = readHeartbeat(workDir, name)
  return !!h && Number.isInteger(h.pid) && typeof h.t === 'number' && now - h.t <= STALE_MS && h.t - now < STALE_MS && alive(h.pid)
}
