// 橋的記錄（bridge.mjs、bridge-aegis.mjs 共用）。2026-10-13 的事故：主控台（stderr）寫不出去後，console.error 丟例外 →
// uncaughtException 又呼叫 log → 又丟例外……無限迴圈，bridge.log 一天長到 181 GB、塞滿 C 槽。這裡守住三件事：
//   1. stderr 寫不出去（同步丟例外，或之後非同步發出 'error'，例如 EPIPE）：記下來、之後只寫檔，不再碰 stderr，也不讓錯誤變成 uncaughtException。
//   2. 不重入：log 裡面又呼叫 log（例如錯誤處理器）就丟掉，不會遞迴。
//   3. 檔案有上限：超過 maxBytes 就把目前的檔改名成 .1（覆蓋舊的 .1）重新開始；同一句話連續重複只記一次、之後記「重複 N 次」。
import fs from 'node:fs'

export const LOG_MAX_BYTES = 20 * 1024 * 1024

/**
 * 做一個 log(msg)。
 * @param {string} file 記錄檔
 * @param {{ maxBytes?: number, stderr?: NodeJS.WritableStream | null, now?: () => Date }} [o]
 */
export function createLog(file, o = {}) {
  const maxBytes = o.maxBytes ?? LOG_MAX_BYTES
  const now = o.now ?? (() => new Date())
  let stderr = o.stderr === undefined ? process.stderr : o.stderr
  let busy = false
  let size = 0
  try { size = fs.statSync(file).size } catch {}
  let last = null, repeats = 0

  const dropStderr = () => { stderr = null }
  // 非同步的寫入錯誤（EPIPE 等）會變成 'error' 事件；沒人聽就是 uncaughtException
  if (stderr && typeof stderr.on === 'function') stderr.on('error', dropStderr)

  const append = line => {
    try {
      if (size + line.length + 1 > maxBytes) {
        try { fs.renameSync(file, file + '.1') } catch {}
        size = 0
      }
      fs.appendFileSync(file, line + '\n')
      size += Buffer.byteLength(line) + 1
    } catch {}
  }

  const write = line => {
    if (stderr) { try { stderr.write(line + '\n') } catch { dropStderr() } }
    append(line)
  }

  const log = msg => {
    if (busy) return // 記錄的時候又出錯又要記：丟掉，不遞迴
    busy = true
    try {
      const text = String(msg)
      if (text === last) { repeats++; return }
      if (repeats > 0) write(`${now().toISOString()} （上一句又重複了 ${repeats} 次）`)
      last = text; repeats = 0
      write(`${now().toISOString()} ${text}`)
    } finally { busy = false }
  }
  log.stderrAlive = () => stderr != null
  return log
}
