// 讀瀏覽器的 DevToolsActivePort（#1954）。
// 慢的 runner 上，Chrome 剛建檔、還沒放鎖或還沒寫完就去讀，會撞 EBUSY（或剛好還不存在的 ENOENT）。
// 這兩種、以及「內容還不到兩行」都短輪詢重試（預設每 100ms、最多 5 秒）；其他錯誤照舊直接丟。
import fs from 'node:fs'

const RETRY_CODES = new Set(['EBUSY', 'ENOENT'])

/** 解析檔案內容：第一行埠號、第二行 ws 路徑；不完整回 null */
export const parseDevToolsPort = text => {
  const [port, wsPath] = String(text).trim().split(/\r?\n/)
  return /^\d+$/.test(port ?? '') && (wsPath ?? '').startsWith('/') ? { port, wsPath } : null
}

export async function readDevToolsPort(file, {
  read = f => fs.readFileSync(f, 'utf8'),
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  now = Date.now,
  limitMs = 5000,
  stepMs = 100,
} = {}) {
  const until = now() + limitMs
  let last = ''
  for (;;) {
    try {
      const got = parseDevToolsPort(read(file))
      if (got) return got
      last = '內容還不完整'
    } catch (e) {
      if (!RETRY_CODES.has(e?.code)) throw e
      last = e.code
    }
    if (now() >= until) throw new Error(`讀不到瀏覽器的偵錯連線檔（${limitMs / 1000} 秒內一直是 ${last}）：${file}`)
    await sleep(stepMs)
  }
}
