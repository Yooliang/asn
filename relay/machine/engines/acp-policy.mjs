// ACP 工作者的權限政策（純函式，不碰檔案、不碰行程，方便測試）。
// 政策＝每個「類別」一個決定 allow／deny／ask，外加「白名單資料夾」（有路徑的請求，路徑在白名單外一律拒絕）。
//   read     讀檔、搜尋、思考         預設 allow
//   write    寫檔、刪檔、搬檔         預設 allow（有路徑的請求以白名單資料夾為界，預設只有工作資料夾）
//   execute  執行指令                 預設 allow（指令沒有路徑可查，邊界只靠工作資料夾與明寫設定）
//   network  上網抓網頁、搜尋         預設 allow（只讀資訊；要全封閉就設 deny）
//   other    分不出類別的請求         預設 deny
// ask＝問人：轉接器把請求摘要寄給指定的人，等回覆（見 acp-approvals.mjs）；逾時一律當拒絕。
import path from 'node:path'
import { agyBrainDir, insideAgyConvDir, norm, validConvId } from './acp-brain.mjs'
import { DATA_FAILED_TEXT, currentSensitiveData, sensitiveDataStatus } from './acp-sensitive-data.mjs'
import { ReadVerdict, extractReadPaths, paramKeys, readToolOfAcpKind, readToolOfAgy, readVerdict, ReadTool } from './acp-sensitive.mjs'

// agy 自己各段對話的資料夾（#2351）在 acp-brain.mjs；從這裡也拿得到
export { agyBrainDir, insideAgyConvDir, validConvId }

export const CATEGORIES = ['read', 'write', 'execute', 'network', 'other']
export const VERDICTS = ['allow', 'deny', 'ask']
export const DEFAULT_RULES = Object.freeze({ read: 'allow', write: 'allow', execute: 'allow', network: 'allow', other: 'deny' })

const CATEGORY_LABEL = { read: '讀取', write: '寫入', execute: '執行指令', network: '上網', other: '其他動作' }
export const categoryLabel = c => CATEGORY_LABEL[c] ?? c

// ACP 的 toolCall.kind → 類別（協定的 kind：read, edit, delete, move, search, execute, think, fetch, switch_mode, other）
export function categoryOfAcpKind(kind) {
  switch (String(kind ?? '').toLowerCase()) {
    case 'read': case 'search': case 'think': return 'read'
    case 'edit': case 'delete': case 'move': return 'write'
    case 'execute': return 'execute'
    case 'fetch': return 'network'
    default: return 'other'
  }
}

// agy 原生 stream-json 的工具名 → 類別（白名單；與電腦版 acp_policy.rs 同一份分類，表在 relay/shared/sensitive-roots.json 的 agyTools）。
// 'internal'＝代理自己的內部控制（規劃、等待、結束…），一律放行；會啟動指令、子代理、工作流程、外部工具，或把訊息、排程送出去的，都照執行類的政策。
// 沒登記的新工具名先用關鍵字推測（寫入、網路比預設更具體）；推測不出來照執行類處理，不再當內部控制放行（呼叫端用 isRegisteredAgyTool 判斷要不要記 log）
// 第一次用到才建（清單不在匯入時讀）；清單換了一份（測試改讀別的檔）就重建
let agyIndexCache = null
function agyIndex() {
  const data = currentSensitiveData()
  if (agyIndexCache && agyIndexCache.data === data) return agyIndexCache.index
  const index = new Map(['read', 'write', 'execute', 'network', 'internal'].flatMap(c => data.agyTools[c].map(n => [n, c])))
  agyIndexCache = { data, index }
  return index
}
/** 這個工具名登記過嗎。沒登記的會用關鍵字推測類別、推不出來照執行類處理，呼叫端要記一行 log，不能默默放行 */
export const isRegisteredAgyTool = name => agyIndex().has(String(name ?? '').toLowerCase())
export function categoryOfAgyTool(name) {
  const n = String(name ?? '').toLowerCase()
  if (agyIndex().has(n)) return agyIndex().get(n)
  if (n.startsWith('browser_')) return 'network'
  if (['write', 'edit', 'replace', 'delete', 'remove', 'move', 'create', 'patch', 'sed_'].some(k => n.includes(k))) return 'write'
  if (['run', 'exec', 'command', 'shell', 'terminal', 'bash'].some(k => n.includes(k))) return 'execute'
  if (['url', 'web', 'http', 'fetch'].some(k => n.includes(k))) return 'network'
  return 'execute'
}

const isVerdict = v => VERDICTS.includes(v)

// raw：agents.json 裡的 permissions；cwd：工作者的工作資料夾（預設白名單）。回傳 { rules, allowDirs, warnings }
export function normalizePermissions(raw, cwd) {
  const warnings = []
  const src = raw && typeof raw === 'object' ? raw : {}
  const rules = { ...DEFAULT_RULES }
  for (const c of CATEGORIES) {
    if (src[c] === undefined) continue
    if (isVerdict(src[c])) rules[c] = src[c]
    else warnings.push(`permissions.${c} 必須是 allow／deny／ask，收到 ${JSON.stringify(src[c])}，改用預設 ${DEFAULT_RULES[c]}`)
  }
  for (const k of Object.keys(src)) if (!CATEGORIES.includes(k) && k !== 'allow_dirs') warnings.push(`permissions.${k} 不認得，已忽略`)
  const dirs = Array.isArray(src.allow_dirs) && src.allow_dirs.length ? src.allow_dirs : [cwd]
  const allowDirs = dirs.filter(d => typeof d === 'string' && d.trim()).map(d => path.resolve(d))
  if (!allowDirs.length) allowDirs.push(path.resolve(cwd))
  return { rules, allowDirs, warnings }
}

export function insideDirs(p, dirs, base) {
  const abs = norm(path.resolve(base ?? dirs[0] ?? '.', String(p)))
  return dirs.some(d => {
    const nd = norm(d)
    const rel = path.relative(nd, abs)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

// ---- 讀取的敏感位置（#2356）----
// 讀取沒有帶路徑時的提醒（寫進 log 的原因文字）
export const NO_READ_PATH_NOTE = '讀取請求沒有可辨識的路徑，無法檢查敏感位置'

/** 路徑逐一判定（讀取類工具用 req.paths，其他工具用參數裡抽到的路徑）。回傳 { verdict, reason }（擋下的原因）或 null（都可以讀） */
export function pathsBlockReason(roots, paths, tool, base) {
  // 敏感位置清單載入失敗：連沒帶路徑的請求也擋（判定本身做不了）
  if (!sensitiveDataStatus().ok) return { verdict: ReadVerdict.Unresolvable, reason: DATA_FAILED_TEXT }
  // 敏感位置清單載入失敗：連沒帶路徑的請求也擋（判定本身做不了）
  const ctx = { roots, base, tool }
  for (const p of paths) {
    const shown = clip(p, 160)
    const v = readVerdict(p, ctx)
    if (v === ReadVerdict.Sensitive) return { verdict: v, reason: `這個位置不能讀（登入資料、金鑰或設定）：${shown}` }
    if (v === ReadVerdict.Unresolvable) return { verdict: v, reason: `路徑無法解析，偏向不讀：${shown}` }
  }
  return null
}
export const readBlockReason = (roots, req, base) => pathsBlockReason(roots, req.paths ?? [], req.readTool ?? ReadTool.Single, base)

// 請求：{ category, paths, scanPaths?, readTool?, paramKeys? }。回傳 { verdict, reason }。
// 內部控制一律放行；寫入有路徑在白名單外就拒絕；讀取不看白名單資料夾，只擋敏感位置（policy.sensitive 由工作者建立時算好放進來；沒有就不檢查讀取，只有單元測試會這樣）。
// 不是讀取、寫入的請求（執行、網路、分不出類別），參數裡抽得到路徑的也照讀取判定
export function decide(policy, { category, paths = [], scanPaths = [], readTool, paramKeys: keys = [] }, base) {
  const rule = policy.rules[category] ?? policy.rules.other
  const roots = policy.sensitive
  // 敏感位置清單載入失敗：讀取、執行、上網、分不出類別的請求都沒辦法檢查路徑，一律拒絕（寫入只看白名單資料夾，不受影響）
  if (roots && category !== 'write' && !sensitiveDataStatus().ok) return { verdict: 'deny', reason: DATA_FAILED_TEXT }
  // 敏感位置清單載入失敗：讀取、執行、上網、分不出類別的請求都沒辦法檢查路徑，一律拒絕（寫入只看白名單資料夾，不受影響）
  if (category !== 'read' && category !== 'write' && scanPaths.length && roots) {
    const why = pathsBlockReason(roots, scanPaths, readTool ?? ReadTool.Single, base)
    if (why) return { verdict: 'deny', reason: why.reason }
  }
  if (category === 'internal') return { verdict: 'allow', reason: '內部控制' }
  if (category === 'read' && roots) {
    if (!paths.length) return { verdict: rule, reason: `${categoryLabel(category)}的政策是 ${rule}（${NO_READ_PATH_NOTE}；欄位：${keys.join('、')}）` }
    const why = pathsBlockReason(roots, paths, readTool ?? ReadTool.Single, base)
    if (why) return { verdict: 'deny', reason: why.reason }
  }
  const outside = category === 'write' ? paths.filter(p => !insideDirs(p, policy.allowDirs, base)) : []
  if (outside.length) return { verdict: 'deny', reason: `路徑在白名單資料夾之外：${redact(outside[0])}` }
  return { verdict: rule, reason: `${categoryLabel(category)}的政策是 ${rule}` }
}

// ---- 摘要（要寄給人看的，不含機密）-----------------------------------------------------------------------------
const MASK = '［已遮蔽］'
// 共用的遮蔽規則（Rust 端 acp_policy.rs 用同一份）：依序套用，每一步都是子字串比對。
// 值的寫法：整段引號、或到空白／引號／& # , ; ) 為止
const VAL = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'&#,;)]+)`
const REDACT_RULES = [
  [/(^|[^a-z0-9+.-])([a-z][a-z0-9+.-]{0,19}:\/\/)[^/\s:@]*:[^/\s@]*@/gi, `$1$2${MASK}@`],
  [new RegExp(String.raw`(authorization["']?[ \t]*[=:][ \t]*)(?:(?:bearer|basic)[ \t]+)?` + VAL, 'gi'), `$1${MASK}`],
  [/\bbearer[ \t]+[^\s"'`]+/gi, MASK],
  [new RegExp(String.raw`((?:(?:api[_-]?key|token|secret|password|passwd|passphrase|credential|signature)[A-Za-z0-9_-]{0,40}["']?[ \t]*[=:]|key["']?[ \t]*=)[ \t]*)` + VAL, 'gi'), `$1${MASK}`],
  [/(^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/gi, `$1${MASK}`],
]
export function redact(s) { return REDACT_RULES.reduce((t, [re, rep]) => t.replace(re, rep), String(s ?? '')) }
const clip = (s, n) => { const t = redact(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }

// ACP session/request_permission 的 params → { category, paths, summary }
export function describeAcpRequest(params) {
  const tc = params?.toolCall ?? {}
  const category = categoryOfAcpKind(tc.kind)
  const paths = [...(tc.locations ?? []).map(l => l?.path), tc.rawInput?.path, tc.rawInput?.file_path, tc.rawInput?.filePath].filter(p => typeof p === 'string' && p)
  // 讀取：參數裡所有像路徑的字串（含陣列、巢狀）都要逐一判定，不只認固定幾個欄位
  if (category === 'read' && tc.rawInput !== undefined) paths.push(...extractReadPaths(tc.rawInput))
  const cmd = typeof tc.rawInput?.command === 'string' ? tc.rawInput.command : Array.isArray(tc.rawInput?.command) ? tc.rawInput.command.join(' ') : ''
  const uniq = [...new Set(paths.filter(p => p !== ''))]
  const what = cmd ? `指令：${clip(cmd, 160)}` : uniq.length ? `檔案：${clip(uniq[0], 160)}` : tc.title ? clip(tc.title, 160) : '（沒有說明）'
  // 不是讀取、寫入的請求：參數裡抽到的路徑照讀取判定
  const scanPaths = category !== 'read' && category !== 'write' && tc.rawInput !== undefined ? extractReadPaths(tc.rawInput) : []
  return {
    category, paths: uniq, summary: `${categoryLabel(category)}：${what}`,
    tool: String(tc.kind ?? ''), readTool: readToolOfAcpKind(tc.kind), scanPaths, paramKeys: paramKeys(tc.rawInput),
  }
}

// agy tool_info.parameters → 路徑與摘要
export function describeAgyTool(toolName, parameters) {
  const category = categoryOfAgyTool(toolName)
  const p = parameters && typeof parameters === 'object' ? parameters : {}
  const paths = Object.entries(p).filter(([k, v]) => /(path|file|dir|target)/i.test(k) && typeof v === 'string' && v).map(([, v]) => v)
  // 讀取：所有字串值（含陣列、巢狀）裡像路徑的都要逐一判定
  if (category === 'read' && parameters !== undefined && parameters !== null) paths.push(...extractReadPaths(parameters))
  const uniq = [...new Set(paths)]
  const cmd = typeof p.CommandLine === 'string' ? p.CommandLine : typeof p.command === 'string' ? p.command : ''
  const what = cmd ? `指令：${clip(cmd, 160)}` : uniq.length ? `檔案：${clip(uniq[0], 160)}` : clip(toolName, 60)
  // 不是讀取、寫入的工具（含沒登記的、會呼叫外部工具的）：參數裡抽得到路徑就照讀取判定。登記過的純狀態更新不碰檔案，不掃
  const scan = category !== 'read' && category !== 'write' && !(category === 'internal' && isRegisteredAgyTool(toolName))
  const scanPaths = scan && parameters !== undefined && parameters !== null ? extractReadPaths(parameters) : []
  return {
    category, paths: uniq, summary: `${categoryLabel(category)}：${what}`,
    tool: String(toolName ?? ''), readTool: readToolOfAgy(toolName), scanPaths, paramKeys: paramKeys(parameters),
  }
}
