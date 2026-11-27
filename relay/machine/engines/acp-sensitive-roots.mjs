// 敏感根清單（與 Rust 端 acp_sensitive.rs 的 SensitiveRoots::build 對應）。啟動時算好（每個家目錄各算一次，字面與實際位置兩種形式），之後每次請求只比字串。
import fs from 'node:fs'
import path from 'node:path'
import { agyBrainDir } from './acp-brain.mjs'
import { DATA } from './acp-sensitive-data.mjs'
import { nstr, realPathWith } from './acp-sensitive-path.mjs'

/** 這次讀取是哪一類工具：單檔讀取、只列名字的列舉、會掃內容的遞迴搜尋 */
export const ReadTool = Object.freeze({ Single: 'single', List: 'list', Recursive: 'recursive' })

export function readToolOfAgy(name) {
  const n = String(name ?? '').toLowerCase()
  if (DATA.agyTools.list.includes(n)) return ReadTool.List
  if (DATA.agyTools.recursive.includes(n)) return ReadTool.Recursive
  return ReadTool.Single
}
export const readToolOfAcpKind = kind => (String(kind ?? '').toLowerCase() === 'search' ? ReadTool.Recursive : ReadTool.Single)

export const stdCanon = p => fs.realpathSync.native(p)

/** 環境變數：物件或 [名, 值] 陣列都收，只留字串值，回傳 [名, 值] 陣列 */
export function envPairs(env) {
  const list = Array.isArray(env) ? env : Object.entries(env ?? {})
  return list.filter(([k, v]) => typeof k === 'string' && typeof v === 'string')
}

const getEnv = (env, n) => {
  const hit = env.find(([k, v]) => k.toUpperCase() === n.toUpperCase() && v.trim() !== '')
  return hit ? hit[1].trim() : null
}

/** 字面與實際位置兩種形式都放進清單（去重） */
export function pushForms(out, p, canon) {
  const add = s => { if (!out.includes(s)) out.push(s) }
  add(nstr(p))
  const r = realPathWith(canon, p)
  if (r !== null) add(nstr(r))
  return out
}

/** 要算敏感根的家目錄：工作者環境裡的 USERPROFILE 與 HOME（兩個都算，沒有就不算）＋這台電腦實際的使用者資料夾 */
export function homesFrom(env, realHome) {
  const pairs = envPairs(env)
  const get = n => { const hit = pairs.find(([k, v]) => k.toUpperCase() === n && v.trim() !== ''); return hit ? hit[1] : null }
  const out = []
  for (const h of [get('USERPROFILE'), get('HOME'), realHome ?? null]) {
    if (h !== null && h !== '' && !out.includes(h)) out.push(h)
  }
  return out
}

const isAbs = p => path.isAbsolute(p) || p.startsWith('/')

/** homes：agy 環境的家目錄＋這台電腦實際的使用者資料夾；env：展開變數與環境變數指定位置用。canon 可注入（測試用） */
export function buildRoots(homes, envIn, canon = stdCanon) {
  const env = envPairs(envIn)
  const homeStrs = []
  for (const h of homes) pushForms(homeStrs, h, canon)
  const paths = []
  for (const h of homes) for (const d of [...DATA.homeDirs, ...DATA.extraHomePaths]) paths.push(path.join(h, d))
  const envPaths = DATA.envRoots.map(n => getEnv(env, n)).filter(v => v !== null)
  const la = getEnv(env, 'LOCALAPPDATA')
  if (la !== null) for (const r of DATA.localAppDataRoots) envPaths.push(path.join(la, r))
  const ap = getEnv(env, 'APPDATA')
  if (ap !== null) for (const r of DATA.appDataRoots) envPaths.push(path.join(ap, r))
  for (const p of envPaths) {
    if (!isAbs(p)) continue
    // 指到使用者資料夾本身或它的上層會把整個家都擋掉：設錯了，不採用
    const n = nstr(p)
    if (homeStrs.some(h => h === n || h.startsWith(`${n}/`))) continue
    paths.push(p)
  }
  const roots = []
  for (const p of paths) pushForms(roots, p, canon)
  const prefixFiles = []
  for (const h of homes) {
    for (const [d, pre] of DATA.prefixHomeFiles) {
      for (const dir of pushForms([], path.join(h, d), canon)) {
        if (!prefixFiles.some(([x, y]) => x === dir && y === pre)) prefixFiles.push([dir, pre])
      }
    }
  }
  // 別人的家目錄：自己的家所在資料夾若叫 users／home，同一層其他資料夾都算別人的
  const otherHomeParents = [...DATA.otherHomeParents]
  for (const h of homeStrs) {
    const k = h.lastIndexOf('/')
    if (k < 0) continue
    const parent = h.slice(0, k)
    if ((parent.endsWith('/users') || parent.endsWith('/home') || parent === 'users' || parent === 'home') && !otherHomeParents.includes(parent)) otherHomeParents.push(parent)
  }
  const localNames = ['localhost', '127.0.0.1']
  const cn = env.find(([k, v]) => k.toUpperCase() === 'COMPUTERNAME' && v.trim() !== '')
  if (cn) localNames.push(cn[1].trim().toLowerCase())
  return sealRoots({
    roots, prefixFiles, otherHomeParents, localNames,
    homes: homeStrs, homePaths: [...homes],
    brains: homes.map(h => agyBrainDir({ USERPROFILE: h })),
    exemptDirs: [], env, canon,
  })
}

/** 凍結並蓋掉印出的樣子：裡面存著環境變數（可能含金鑰），不能被 console 或 log 印出來（對應 Rust 端手寫的 Debug） */
export function sealRoots(o) {
  Object.defineProperty(o, Symbol.for('nodejs.util.inspect.custom'), { value: () => `SensitiveRoots { roots: ${o.roots.length}, homes: ${o.homes.length} }`, enumerable: false })
  Object.defineProperty(o, 'toJSON', { value: () => ({ roots: o.roots.length, homes: o.homes.length }), enumerable: false })
  return Object.freeze(o)
}
