// 敏感位置清單與判定參數：讀共用的 relay/shared/sensitive-roots.json（電腦版 Rust 端用守門測試逐項比對同一份）。
// 清單只在那份檔裡定義；這裡不另寫第二份。
//
// 載入時機：第一次有人用到清單時才讀（背景夥伴引擎建立時、或第一次判定時），不在匯入時讀。
// 讀不到、格式壞、必要欄位缺或型別不對、清單欄位是空的，都記成「載入失敗」：
//   - 只影響背景夥伴（ACP）引擎，機器橋其餘功能照常；
//   - 失敗時讀取判定一律擋（readVerdict／decide／checkTool 先看 sensitiveDataStatus），不會放行；
//   - 錯誤訊息帶檔案路徑與欄位名（寫進 log）；給人看的白話文字用 DATA_FAILED_TEXT。
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const DEFAULT_FILE = fileURLToPath(new URL('../../shared/sensitive-roots.json', import.meta.url))

/** 載入失敗時給人看的白話文字（原文與欄位名只進 log） */
export const DATA_FAILED_TEXT = '讀取檢查設定載入失敗，背景夥伴暫時不能讀檔'

export class SensitiveDataError extends Error {
  constructor(file, field, why) {
    super(`敏感位置清單 ${file} 的 ${field} ${why}`)
    this.name = 'SensitiveDataError'
    this.file = file
    this.field = field
  }
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = v => typeof v === 'string' && v !== ''
const isPosInt = v => Number.isInteger(v) && v > 0

// 欄位規格：每個檢查函式回傳 null（合格）或不合格的原因
const strList = v => (!Array.isArray(v) ? '必須是陣列' : !v.length ? '不能是空陣列' : v.every(isStr) ? null : '的每一項都必須是非空字串')
const str = v => (isStr(v) ? null : '必須是非空字串')
const posInt = v => (isPosInt(v) ? null : '必須是正整數')
const pairList = v => (!Array.isArray(v) ? '必須是陣列' : !v.length ? '不能是空陣列'
  : v.every(p => Array.isArray(p) && p.length === 2 && p.every(isStr)) ? null : '的每一項都必須是兩個非空字串組成的陣列')
const objOf = shape => v => {
  if (!isObj(v)) return '必須是物件'
  for (const [k, check] of Object.entries(shape)) {
    const why = check(v[k])
    if (why) return { field: k, why }
  }
  return null
}

const SCHEMA = {
  homeDirs: strList,
  asnDirNames: strList,
  extraHomePaths: strList,
  prefixHomeFiles: pairList,
  envRoots: strList,
  localAppDataRoots: strList,
  appDataRoots: strList,
  hostKeyDir: str,
  systemFiles: strList,
  otherHomeParents: strList,
  sharedHomeNames: strList,
  maxPathLen: posInt,
  maxJsonDepth: posInt,
  pathKeyWords: strList,
  skipKeys: strList,
  prose: objOf({ lead: str, trail: str, trim: str, maxHits: posInt, maxStarts: posInt }),
  agyTools: objOf({ read: strList, write: strList, execute: strList, network: strList, internal: strList, list: strList, recursive: strList }),
  preambleReadOk: str,
}

/** 讀檔並驗證。成功回傳凍結的資料；失敗丟 SensitiveDataError（帶檔案路徑與欄位名） */
export function loadSensitiveData(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) { throw new SensitiveDataError(file, '（整份檔）', `讀不到：${e.code ?? e.message}`) }
  let data
  try { data = JSON.parse(text) } catch (e) { throw new SensitiveDataError(file, '（整份檔）', `不是合格的 JSON：${e.message}`) }
  if (!isObj(data)) throw new SensitiveDataError(file, '（整份檔）', '最外層必須是物件')
  for (const [field, check] of Object.entries(SCHEMA)) {
    if (data[field] === undefined) throw new SensitiveDataError(file, field, '缺少，必要欄位')
    const why = check(data[field])
    if (why) throw new SensitiveDataError(file, typeof why === 'object' ? `${field}.${why.field}` : field, typeof why === 'object' ? why.why : why)
  }
  return deepFreeze(data)
}

function deepFreeze(o) {
  if (o !== null && typeof o === 'object') for (const v of Object.values(o)) deepFreeze(v)
  return Object.freeze(o)
}

// 載入失敗時 DATA 回的形狀（全空，只讓還在用清單的程式不會丟例外；判定那邊一律先看 sensitiveDataStatus 擋掉）
const FALLBACK = deepFreeze({
  homeDirs: [], asnDirNames: [], extraHomePaths: [], prefixHomeFiles: [], envRoots: [], localAppDataRoots: [], appDataRoots: [],
  hostKeyDir: '', systemFiles: [], otherHomeParents: [], sharedHomeNames: [], maxPathLen: 4096, maxJsonDepth: 4,
  pathKeyWords: [], skipKeys: [],
  prose: { lead: '', trail: '', trim: '', maxHits: 50, maxStarts: 8 },
  agyTools: { read: [], write: [], execute: [], network: [], internal: [], list: [], recursive: [] },
  preambleReadOk: '讀取檔案（目前讀取檢查設定載入失敗，讀取一律會被擋）',
})

let source = DEFAULT_FILE
let state = null // { ok:true, data } | { ok:false, error, data: FALLBACK }

function ensure() {
  if (state) return state
  try { state = { ok: true, data: loadSensitiveData(source) } } catch (error) {
    state = { ok: false, error: error instanceof SensitiveDataError ? error : new SensitiveDataError(source, '（整份檔）', String(error?.message ?? error)), data: FALLBACK }
  }
  return state
}

/** 清單載入得起來嗎。回傳 { ok:true } 或 { ok:false, error }（error.message 帶檔案路徑與欄位名，寫進 log 用）。第一次呼叫才讀檔 */
export function sensitiveDataStatus() {
  const s = ensure()
  return s.ok ? { ok: true } : { ok: false, error: s.error }
}

/** 測試用：改讀別的檔（null＝回到共用的那份），並清掉已載入的結果。回傳還原用的函式 */
export function useSensitiveDataFile(file) {
  const prev = source
  source = file ?? DEFAULT_FILE
  state = null
  return () => { source = prev; state = null }
}

/** 目前的清單（載入失敗時是全空的樣子）。一般用 DATA；要拿整份物件的地方（例如比對是否換了一份）用這個 */
export const currentSensitiveData = () => ensure().data

/** 清單本體：每次取欄位才（第一次）載入 */
export const DATA = new Proxy({}, {
  get: (_t, k) => ensure().data[k],
  has: (_t, k) => k in ensure().data,
  ownKeys: () => Reflect.ownKeys(ensure().data),
  getOwnPropertyDescriptor: (_t, k) => (k in ensure().data ? { enumerable: true, configurable: true, value: ensure().data[k] } : undefined),
})

export const IS_WIN = process.platform === 'win32'

// 一般文字的空白判定要跟 Rust 的 char::is_whitespace 一樣（JS 的 \s 多收了位元組順序記號）
const WS = '\\t-\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
export const RE_WS = new RegExp(`[${WS}]`)
const isWsCode = c => (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
  || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000
/** 去掉頭尾空白：從兩端逐字元往內看（線性時間；字串中間有大量連續空白時，不會像「^空白+|空白+$」的正規式那樣變成平方時間） */
export const trimWs = s => {
  let a = 0
  let b = s.length
  while (a < b && isWsCode(s.charCodeAt(a))) a += 1
  while (b > a && isWsCode(s.charCodeAt(b - 1))) b -= 1
  return a === 0 && b === s.length ? s : s.slice(a, b)
}
export const hasWs = s => RE_WS.test(s)
/** UTF-8 位元組長度（長度上限是以位元組算的） */
export const byteLen = s => Buffer.byteLength(s, 'utf8')
