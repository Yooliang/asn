// 使用者資料夾的「單一解析函式」（ONBOARDING §5.2、§5.3；#14 R2）。金鑰、節點代號、橋的工作資料夾都放在這裡。
// 新位置 ~/.asn（Windows %USERPROFILE%\.asn），舊位置 ~/.irori-relay 仍讀得到。ASN 電腦版啟動時會做「合併式遷移」
// （Rust 端 home_migrate.rs），這裡只負責「現在該用哪個資料夾」，不搬任何東西、不建任何東西。
//
// 解析順序：
//   1. 環境變數 ASN_HOME（舊名 IRORI_HOME，經 env-compat）→ 直接用，不看舊位置
//   2. ~/.asn 不存在：~/.irori-relay 存在就用舊的，都沒有就用 ~/.asn（由寫入的人負責建立）
//   3. ~/.asn 存在：
//      - ~/.irori-relay 是連結（遷移完成後的相容連結）或不存在或是空資料夾 → 用 ~/.asn
//      - ~/.irori-relay 是有內容的真資料夾（還沒遷移：例如舊橋還在跑、遷移被放棄）→ 用舊的，
//        新位置當後備（fallback）：主要位置找不到的檔案再回頭找後備。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { envGet } from './env-compat.mjs'

export const NEW_DIR_NAME = '.asn'
export const LEGACY_DIR_NAME = '.irori-relay'

// 'link'（含 Windows 目錄接合點）、'dir'、'other'、null（不存在）
function kindOf(p) {
  try {
    const s = fs.lstatSync(p)
    if (s.isSymbolicLink()) return 'link'
    return s.isDirectory() ? 'dir' : 'other'
  } catch { return null }
}
function nonEmptyDir(p) { try { return fs.readdirSync(p).length > 0 } catch { return false } }

/** 回傳 { primary, fallback, state }；state：override／fresh／legacy／new／linked／pending。base、env 可注入（測試用）。 */
export function resolveHome({ base = os.homedir(), env = process.env } = {}) {
  const override = String(envGet(env, 'HOME') ?? '').trim()
  if (override) return { primary: path.resolve(override), fallback: null, state: 'override' }
  const fresh = path.join(base, NEW_DIR_NAME)
  const legacy = path.join(base, LEGACY_DIR_NAME)
  const kn = kindOf(fresh)
  const kl = kindOf(legacy)
  if (kn === null) {
    return kl === 'dir' || kl === 'link' ? { primary: legacy, fallback: null, state: 'legacy' } : { primary: fresh, fallback: null, state: 'fresh' }
  }
  if (kl === 'dir' && nonEmptyDir(legacy)) return { primary: legacy, fallback: fresh, state: 'pending' }
  return { primary: fresh, fallback: null, state: kl === 'link' ? 'linked' : 'new' }
}

/** 找一個檔案或子資料夾：主要位置有就用；沒有而後備有就用後備；都沒有回主要位置的路徑（給寫入用）。 */
export function locateIn(info, ...names) {
  const main = path.join(info.primary, ...names)
  if (!info.fallback || fs.existsSync(main)) return main
  const alt = path.join(info.fallback, ...names)
  return fs.existsSync(alt) ? alt : main
}

// 這個行程啟動時的解析結果（橋與指令都是短命或啟動後不換資料夾；遷移要等舊橋結束才會做）
export const HOME_INFO = resolveHome()
export const HOME_DIR = HOME_INFO.primary
export const locateHome = (...names) => locateIn(HOME_INFO, ...names)
