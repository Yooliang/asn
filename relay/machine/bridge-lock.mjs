// 單一實例鎖 bridge.pid（bridge.mjs、bridge-aegis.mjs 經 relay-core、identity.mjs 共用）。
// #1373：橋被強制結束時來不及刪 bridge.pid，Windows 回收程序編號很快，只看「編號活著」會把別的程序誤認成另一個橋。
//
// 檔案：
//   bridge.pid        內容只有十進位編號（不改格式：ASN 內建橋 relay/asn/src-tauri/src/bridge/lock.rs 與舊版 Node 橋都這樣讀寫，
//                     寫成別的格式會讓它們以為沒有橋在跑、同時收信）
//   bridge.pid.start  {"pid":123,"start":"<token>"}：Node 橋寫 bridge.pid 之後緊接著寫，記自己的程序啟動時間
//                     （作業系統給的原始值，當不透明字串比對：Linux /proc/<pid>/stat 的 starttime、Windows Get-Process 的 StartTime）
// 判定「另一個橋在跑」：編號活著，且
//   - 啟動時間記錄有效（編號相同、不比 bridge.pid 舊）→ 現在查到的啟動時間要一致；不一致＝編號被回收，殘留檔，覆寫
//   - 沒有有效記錄（舊版 Node 橋或 ASN 寫的、寫入時沒查到）→ 退回只看編號是否存活（＝原本的行為）
//   - 查不到現在的啟動時間（逾時、沒權限）→ 保守當作在跑：寧可不啟動，也不要兩個橋同時收信
// 這裡從不結束任何程序。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const QUERY_TIMEOUT_MS = 15_000

export const stampFile = lockFile => `${lockFile}.start`

/** bridge.pid 的內容 → 編號；壞掉回 null */
export function parsePid(text) {
  const s = String(text ?? '').trim()
  if (!/^\d+$/.test(s)) return null
  const pid = Number(s)
  return pid > 0 && Number.isSafeInteger(pid) ? pid : null
}

/** bridge.pid.start 的內容 → { pid, start }；壞掉回 null */
export function parseStamp(text) {
  let j
  try { j = JSON.parse(String(text ?? '')) } catch { return null }
  if (!j || typeof j !== 'object' || Array.isArray(j) || !Number.isInteger(j.pid) || j.pid <= 0) return null
  return { pid: j.pid, start: typeof j.start === 'string' && j.start ? j.start : null }
}
export const encodeStamp = (pid, start) => JSON.stringify({ pid, start: start ?? null })

const readPid = file => { try { return parsePid(fs.readFileSync(file, 'utf8')) } catch { return null } }
const mtimeMs = file => { try { return fs.statSync(file).mtimeMs } catch { return null } }
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

/** 和 bridge.pid 配得上的啟動時間記錄（編號相同、不比 bridge.pid 舊——別人後來改寫了 bridge.pid 就作廢）；沒有回 null */
function validStamp(lockFile, pid) {
  const sf = stampFile(lockFile)
  let st
  try { st = parseStamp(fs.readFileSync(sf, 'utf8')) } catch { return null }
  if (!st || st.pid !== pid || !st.start) return null
  const lockT = mtimeMs(lockFile), stampT = mtimeMs(sf)
  if (lockT === null || stampT === null || stampT < lockT) return null
  return st
}

// Linux：/proc/<pid>/stat 第 22 欄 starttime（開機後的 clock ticks）。程序名稱可能含空白與括號，從最後一個 ')' 之後切。
function linuxToken(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return rest[19] || null   // rest[0] 是第 3 欄 state
  } catch { return null }
}

/** pids 的啟動時間 token：Map<pid, string|null>。查不到（不存在、沒權限、逾時）就是 null。 */
export function startTokens(pids) {
  const list = [...new Set(pids.filter(p => Number.isInteger(p) && p > 0))]
  const out = new Map(list.map(p => [p, null]))
  if (!list.length) return out
  try {
    if (process.platform === 'linux') { for (const p of list) out.set(p, linuxToken(p)); return out }
    // Windows 用 Get-Process（比 Get-CimInstance 快）；其他（macOS）用 ps。逾時／失敗一律當查不到。
    const txt = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `foreach ($i in @(${list.join(',')})) { try { $p = Get-Process -Id $i -ErrorAction Stop; "$i|$($p.StartTime.ToUniversalTime().Ticks)" } catch {} }`],
      { encoding: 'utf8', windowsHide: true, timeout: QUERY_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })
      : execFileSync('ps', ['-o', 'pid=,lstart=', '-p', list.join(',')], { encoding: 'utf8', timeout: QUERY_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })
        .replace(/^\s*(\d+)\s+/gm, '$1|')
    for (const line of txt.split(/\r?\n/)) {
      const i = line.indexOf('|'), pid = Number(line.slice(0, i).trim()), tok = line.slice(i + 1).trim()
      if (i > 0 && out.has(pid) && tok && tok !== '0') out.set(pid, tok)
    }
  } catch { /* ps 沒有任何符合的編號時也會非零結束；一律當查不到 */ }
  return out
}

/**
 * bridge.pid 記的橋還在跑嗎？在跑回傳它的編號，否則 null（沒檔、壞檔、是自己、編號已死、編號被別的程序回收）。
 * opts.tokens 可注入（測試查詢失敗的情況）。
 */
export function lockHolder(lockFile, { selfPid = process.pid, tokens = startTokens } = {}) {
  const pid = readPid(lockFile)
  if (!pid || pid === selfPid || !alive(pid)) return null
  const st = validStamp(lockFile, pid)
  if (!st) return pid                                  // 沒有有效的啟動時間記錄：只看編號（原行為）
  const now = tokens([pid]).get(pid)
  if (!now) return pid                                 // 查不到：保守當作在跑
  return now === st.start ? pid : null                 // 對不上＝編號被回收，殘留檔
}

export const lockOwnedBy = (lockFile, pid) => readPid(lockFile) === pid

/** 取得鎖：另一個橋在跑就回傳 { ok:false, pid }；否則寫 bridge.pid（只有編號）與啟動時間記錄，結束時刪掉自己的。 */
export function acquireLock(lockFile, selfPid = process.pid) {
  const holder = lockHolder(lockFile, { selfPid })
  if (holder) return { ok: false, pid: holder }
  const sf = stampFile(lockFile)
  try { fs.unlinkSync(sf) } catch {}                   // 先清掉舊記錄，免得寫 bridge.pid 與新記錄之間被配到舊的
  fs.writeFileSync(lockFile, String(selfPid))
  try { fs.writeFileSync(sf, encodeStamp(selfPid, startTokens([selfPid]).get(selfPid))) } catch {}   // 寫不了就退回只看編號
  process.on('exit', () => {
    try { if (lockOwnedBy(lockFile, selfPid)) fs.unlinkSync(lockFile) } catch {}
    try { if (parseStamp(fs.readFileSync(sf, 'utf8'))?.pid === selfPid) fs.unlinkSync(sf) } catch {}
  })
  return { ok: true }
}
