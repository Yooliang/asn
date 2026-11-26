// 敏感位置清單與判定參數：讀共用的 relay/shared/sensitive-roots.json（電腦版 Rust 端用守門測試逐項比對同一份）。
// 清單只在那份檔裡定義；這裡不另寫第二份。
import fs from 'node:fs'

export const DATA = Object.freeze(JSON.parse(fs.readFileSync(new URL('../../shared/sensitive-roots.json', import.meta.url), 'utf8')))

export const SENSITIVE_HOME_DIRS = DATA.homeDirs
export const EXTRA_HOME_PATHS = DATA.extraHomePaths
export const PREFIX_HOME_FILES = DATA.prefixHomeFiles
export const ENV_ROOTS = DATA.envRoots
export const HOST_KEY_DIR = DATA.hostKeyDir
export const SYSTEM_FILES = DATA.systemFiles
export const OTHER_HOME_PARENTS = DATA.otherHomeParents
export const SHARED_HOME_NAMES = DATA.sharedHomeNames
export const MAX_PATH_LEN = DATA.maxPathLen
export const MAX_JSON_DEPTH = DATA.maxJsonDepth

export const IS_WIN = process.platform === 'win32'

// 一般文字的空白判定要跟 Rust 的 char::is_whitespace 一樣（JS 的 \s 多收了位元組順序記號）
const WS = '\\t-\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
export const RE_WS = new RegExp(`[${WS}]`)
const RE_WS_EDGE = new RegExp(`^[${WS}]+|[${WS}]+$`, 'g')
export const trimWs = s => s.replace(RE_WS_EDGE, '')
export const hasWs = s => RE_WS.test(s)
/** UTF-8 位元組長度（長度上限是以位元組算的） */
export const byteLen = s => Buffer.byteLength(s, 'utf8')
