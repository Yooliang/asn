// 單一實例鎖 bridge.pid（bridge.mjs、bridge-aegis.mjs 經 relay-core 共用；identity.mjs 只用 lockPidAlive）。
// 檔案內容只有十進位編號（ASN 內建橋 relay/asn/src-tauri/src/bridge/lock.rs 與舊版 Node 橋都這樣讀寫，格式不變）。
//
// #1373：橋被強制結束時來不及刪 bridge.pid，Windows 回收程序編號很快，只看「編號活著」會把別的程序誤認成另一個橋。
// 判斷規則與 installer/asn-common.ps1 的 Get-RecordedProcess 相同：橋一定先啟動、再寫 bridge.pid，
// 所以編號上那個程序的啟動時間晚於 bridge.pid 的寫入時間（mtime）＋5 秒＝編號已被回收，bridge.pid 是殘留檔。
//   - 編號不在／是自己／檔案壞掉 → 不擋
//   - 編號活著 → 查它的啟動時間（epoch 毫秒，非同步、上限 5 秒）：晚於 mtime＋5 秒 → 殘留檔；否則 → 另一個橋在跑
//   - 查不到啟動時間（逾時、沒權限、失敗）→ 保守當作在跑：寧可不啟動，也不要兩個橋同時收信
// 寫入用 openSync(..., 'wx') 搶：兩個橋同時啟動時只有一個寫得進去，搶輸的重新判斷（最多 LOCK_ROUNDS 輪）。
// 這裡從不結束任何程序。
import { execFile } from 'node:child_process'
import fs from 'node:fs'

export const START_SLACK_MS = 5_000
export const QUERY_TIMEOUT_MS = 5_000
const LOCK_ROUNDS = 3
const FRESH_MS = 1_000        // 剛建立、可能還沒寫進編號的檔案：先等一下再判斷，不當壞檔刪掉
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** bridge.pid 的內容 → 編號；壞掉回 null */
export function parsePid(text) {
  const s = String(text ?? '').trim()
  if (!/^\d+$/.test(s)) return null
  const pid = Number(s)
  return pid > 0 && Number.isSafeInteger(pid) ? pid : null
}

const readRaw = file => { try { return fs.readFileSync(file, 'utf8') } catch { return null } }
const readPid = file => parsePid(readRaw(file))
const mtimeMs = file => { try { return fs.statSync(file).mtimeMs } catch { return null } }
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

/** 輕量檢查（不叫任何子程序）：bridge.pid 記的編號還活著。給寄信路徑（identity.mjs）判斷節點用。 */
export const lockPidAlive = file => { const pid = readPid(file); return pid !== null && alive(pid) }

export const lockOwnedBy = (file, pid) => readPid(file) === pid

const run = (cmd, args, opts) => new Promise(resolve => {
  execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: QUERY_TIMEOUT_MS, ...opts }, (err, out) => resolve(err ? null : out))
})

// Linux：/proc/<pid>/stat 第 22 欄 starttime（開機後的 clock ticks）＋ /proc/stat 的 btime（開機時刻，epoch 秒）。
// clock tick 用 USER_HZ＝100（/proc 對使用者空間固定的單位；不叫 getconf）。btime 只到秒，5 秒寬限足以吸收。
async function linuxStartMs(pid) {
  try {
    const [stat, sys] = await Promise.all([fs.promises.readFile(`/proc/${pid}/stat`, 'utf8'), fs.promises.readFile('/proc/stat', 'utf8')])
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19])   // 從最後一個 ')' 之後切（程序名稱可含空白與括號）；[0] 是第 3 欄
    const btime = Number(/^btime\s+(\d+)/m.exec(sys)?.[1])
    return Number.isFinite(ticks) && btime > 0 ? btime * 1000 + ticks * 10 : null
  } catch { return null }
}

// Windows：Get-Process 的 StartTime 轉成 UTC epoch 毫秒（只輸出數字，不受時區、語系、代碼頁影響）
async function windowsStartMs(pid) {
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `try { ([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() } catch {}`])
  const ms = Number(String(out ?? '').trim())
  return out && Number.isFinite(ms) && ms > 0 ? ms : null
}

// 其他（macOS）：ps -o etime=（已執行多久，[[dd-]hh:]mm:ss，純數字格式）→ 現在減掉它。
// 不用 lstart：那是在地化的日期字串，要處理時區與語系。etime 只到秒，5 秒寬限足以吸收。
async function psStartMs(pid) {
  const now = Date.now()
  const out = await run('ps', ['-o', 'etime=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' } })
  const m = /^\s*(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/.exec(out ?? '')
  if (!m) return null
  const [d, h, mi, s] = m.slice(1).map(v => Number(v ?? 0))
  return now - (((d * 24 + h) * 60 + mi) * 60 + s) * 1000
}

/** 程序的啟動時間（epoch 毫秒）；查不到回 null。非同步，不卡住呼叫者。 */
export function processStartMs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null)
  if (process.platform === 'linux') return linuxStartMs(pid)
  if (process.platform === 'win32') return windowsStartMs(pid)
  return psStartMs(pid)
}

const withTimeout = (p, ms) => {
  let t
  return Promise.race([Promise.resolve(p).catch(() => null), new Promise(r => { t = setTimeout(() => r(null), ms) })]).finally(() => clearTimeout(t))
}

/**
 * bridge.pid 記的橋還在跑嗎？在跑回傳它的編號，否則 null（沒檔、壞檔、是自己、編號已死、編號被回收）。
 * opts.startMs、timeoutMs 可注入（測試查詢失敗、逾時）。
 */
export async function lockHolder(file, { selfPid = process.pid, startMs = processStartMs, timeoutMs = QUERY_TIMEOUT_MS } = {}) {
  const pid = readPid(file)
  if (!pid || pid === selfPid || !alive(pid)) return null
  const written = mtimeMs(file)
  const started = await withTimeout(startMs(pid), timeoutMs)
  if (started === null || written === null) return pid           // 查不到：保守當作在跑
  return started > written + START_SLACK_MS ? null : pid          // 比寫入時間晚啟動＝編號被回收
}

/**
 * 取得鎖：另一個橋在跑就回傳 { ok:false, pid }；否則用 'wx' 寫入自己的編號，結束時刪掉自己的（內容仍是自己的編號才刪）。
 * opts.beforeCreate：測試用，在判定完、建立檔案之前呼叫（模擬別的橋搶先寫入）。
 */
export async function acquireLock(file, selfPid = process.pid, opts = {}) {
  for (let round = 1; round <= LOCK_ROUNDS; round++) {
    const raw = readRaw(file)
    if (raw !== null) {
      const pid = parsePid(raw)
      if (pid === null && round < LOCK_ROUNDS && Date.now() - (mtimeMs(file) ?? 0) < FRESH_MS) { await sleep(200); continue }   // 別的橋剛建檔、還沒寫進編號
      const holder = await lockHolder(file, { selfPid, ...opts })
      if (holder) return { ok: false, pid: holder }
      if (readRaw(file) !== raw) continue                         // 判斷期間檔案被別人改了：重新判斷
      try { fs.unlinkSync(file) } catch (e) { if (e.code !== 'ENOENT') throw e }
    }
    await opts.beforeCreate?.()
    let fd
    try { fd = fs.openSync(file, 'wx') } catch (e) { if (e.code === 'EEXIST') continue; throw e }   // 搶輸：重新判斷
    try { fs.writeSync(fd, String(selfPid)) } finally { fs.closeSync(fd) }
    process.on('exit', () => { try { if (lockOwnedBy(file, selfPid)) fs.unlinkSync(file) } catch {} })
    return { ok: true }
  }
  return { ok: false, pid: readPid(file) ?? 0 }                    // 一直搶輸：保守當作有別的橋
}
