// ack 失敗的信：信已經處理完了，只是後台沒記到。記下來隔一段時間補 ack，拉信時也不再處理一次。
// bridge.mjs 與 bridge-aegis.mjs 共用。清單存 ack-retry.json，重開後接著補。
// 清單真的不見了（超過上限、存檔壞掉）：信會再處理一次，多一封但不會漏信。
import fs from 'node:fs'
import { saveAtomic } from './pending-store.mjs'

export const ACK_RETRY_MAX = 500
export const ACK_RETRY_FIRST_MS = 30_000
export const ACK_RETRY_MAX_GAP_MS = 600_000
export const ACK_RETRY_TICK_MS = 5_000

function loadIds(file, log) {
  try {
    const ids = JSON.parse(fs.readFileSync(file, 'utf8')).ids
    return Array.isArray(ids) ? ids.filter(i => typeof i === 'string').slice(0, ACK_RETRY_MAX) : []
  } catch (e) {
    if (e.code !== 'ENOENT') log(`ack retry file unreadable, ignored: ${e.message}`)
    return []
  }
}

// post(ids)：呼叫後台 ack，失敗要丟例外。seen：已 ack 的編號（Set），成功就加進去。
export function createAckRetry({ post, file, log, seen, firstMs = ACK_RETRY_FIRST_MS, now = Date.now }) {
  let ids = loadIds(file, log)
  let gap = firstMs
  let at = ids.length ? now() : 0   // 重開後讀回的清單：下一個 tick 就補
  let running = false
  if (ids.length) log(`ack retry restored: ${ids.length}`)

  const save = () => {
    try { saveAtomic(file, { ids }) } catch (e) { log(`ack retry save failed: ${e.message}`) }
  }
  const acked = done => {
    done.forEach(i => seen.add(i))
    if (!ids.length) return
    ids = ids.filter(i => !done.includes(i))
    if (!ids.length) { at = 0; gap = firstMs }
    save()
  }
  const failed = list => {
    ids = [...ids, ...list.filter(i => !ids.includes(i))]
    while (ids.length > ACK_RETRY_MAX) log(`ack retry list full: dropped id=${ids.shift()}, it may be handled again`)
    if (!at) { gap = firstMs; at = now() + firstMs }
    save()
  }

  return {
    has: id => ids.includes(id),
    list: () => [...ids],
    tickMs: Math.min(ACK_RETRY_TICK_MS, firstMs),
    async ack(list) {
      if (!list.length) return
      try {
        await post(list)
        acked(list)
      } catch (e) {
        log(`ack failed: ${e.message}`)
        failed(list)
      }
    },
    // 到時間就補一次；一直失敗時間隔加倍，最多 10 分鐘
    async tick() {
      if (running || !ids.length || now() < at) return
      running = true
      const list = [...ids]
      try {
        await post(list)
        log(`ack retry ok: ${list.length}`)
        acked(list)
      } catch (e) {
        gap = Math.min(gap * 2, ACK_RETRY_MAX_GAP_MS)
        at = now() + gap
        log(`ack retry failed: ${list.length} waiting, next in ${Math.round(gap / 1000)}s: ${e.message}`)
      } finally {
        running = false
      }
    },
  }
}
