// Play 的 versionCode 規則：（主×1000000＋次×1000＋修訂）×10＋尾數。
// 尾數：正式版 1、測試版 0、同一版重出 2～9。這樣測試版和正式版永遠不會撞號，版號往上時也一定變大。
// 舊規則（Tauri 預設，不乘 10）最大用到 2006（0.2.6 測試版），新規則的 0.2.6 正式版是 20061，一定比它大。
// 用法（release-play.mjs）：預設正式版；--test 測試版；--reissue=N 重出（N 為 2～9）。

export const PLAY_SUFFIX = Object.freeze({ release: 1, test: 0 })
export const PLAY_CODE_MAX = 2_100_000_000   // Google Play 的上限

/** 版號字串 → Tauri 預設算法的值（主×1000000＋次×1000＋修訂）；格式不對回 null */
export const baseCode = version => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? '').trim())
  if (!m) return null
  const [maj, min, pat] = m.slice(1).map(Number)
  if (min > 999 || pat > 999) return null
  return maj * 1_000_000 + min * 1000 + pat
}

/** 從命令列參數決定尾數；參數不合法丟錯 */
export const suffixFromArgs = argv => {
  const test = argv.includes('--test')
  const re = argv.find(a => a.startsWith('--reissue='))
  if (test && re) throw new Error('--test 和 --reissue 不能一起用')
  if (test) return PLAY_SUFFIX.test
  if (re) {
    const n = Number(re.slice('--reissue='.length))
    if (!Number.isInteger(n) || n < 2 || n > 9) throw new Error('--reissue 只能是 2 到 9')
    return n
  }
  return PLAY_SUFFIX.release
}

/** 這一版要用的 versionCode */
export const playVersionCode = (version, suffix = PLAY_SUFFIX.release) => {
  const base = baseCode(version)
  if (base === null) throw new Error(`版號格式不對：${version}`)
  if (!Number.isInteger(suffix) || suffix < 0 || suffix > 9) throw new Error(`尾數不對：${suffix}`)
  const code = base * 10 + suffix
  if (code > PLAY_CODE_MAX) throw new Error(`versionCode ${code} 超過 Play 上限`)
  return code
}

/** 新的 versionCode 一定要大於 Play 上已有的最大值；否則回錯誤訊息，沒問題回 null */
export const checkAboveMax = (code, max) => {
  if (max == null) return null
  return code > max ? null : `這次的 versionCode ${code} 沒有比 Play 上最大的 ${max} 大，Play 會擋。請改版號，或用 --reissue=2～9 重出同一版。`
}
