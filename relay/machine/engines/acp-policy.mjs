// ACP 工作者的權限政策（純函式，不碰檔案、不碰行程，方便測試）。
// 政策＝每個「類別」一個決定 allow／deny／ask，外加「白名單資料夾」（有路徑的請求，路徑在白名單外一律拒絕）。
//   read     讀檔、搜尋、思考         預設 allow
//   write    寫檔、刪檔、搬檔         預設 allow（有路徑的請求以白名單資料夾為界，預設只有工作資料夾）
//   execute  執行指令                 預設 allow（指令沒有路徑可查，邊界只靠工作資料夾與明寫設定）
//   network  上網抓網頁、搜尋         預設 allow（只讀資訊；要全封閉就設 deny）
//   other    分不出類別的請求         預設 deny
// ask＝問人：轉接器把請求摘要寄給指定的人，等回覆（見 acp-approvals.mjs）；逾時一律當拒絕。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

// agy 原生 stream-json 的工具名 → 類別。'internal'＝代理自己的內部控制（規劃、等待、結束…），一律放行。
// 沒列到的新工具名用關鍵字推測；推測不出來視為 internal（寧可記 log 也不要讓新版 agy 一換工具名就全部被中止）
const AGY_TOOLS = {
  read: ['view_file', 'list_dir', 'find_by_name', 'grep_search', 'read_resource', 'list_resources'],
  write: ['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit'],
  execute: ['run_command', 'send_command_input', 'command_status', 'notebook_execution', 'execute_browser_javascript'],
  network: ['read_url_content', 'search_web', 'open_browser_url', 'read_browser_page', 'capture_browser_console_logs', 'capture_browser_screenshot',
    'list_browser_pages', 'get_browser_dom'],
  internal: ['finish', 'wait', 'wait_5_seconds', 'ask_question', 'ask_permission', 'ask_custom_permission', 'list_permissions', 'manage_task', 'manage_inbox',
    'manage_subagents', 'define_subagent', 'invoke_subagent', 'send_message', 'schedule', 'run_workflow', 'delete_knowledge', 'search_marketplace',
    'list_plugin_accounts', 'call_mcp_tool', 'generate_image'],
}
const AGY_INDEX = new Map(Object.entries(AGY_TOOLS).flatMap(([c, names]) => names.map(n => [n, c])))
export function categoryOfAgyTool(name) {
  const n = String(name ?? '').toLowerCase()
  if (AGY_INDEX.has(n)) return AGY_INDEX.get(n)
  if (n.startsWith('browser_')) return 'network'
  if (/(write|edit|replace|delete|remove|move|create|patch|sed_)/.test(n)) return 'write'
  if (/(run|exec|command|shell|terminal|bash)/.test(n)) return 'execute'
  if (/(url|web|http|fetch)/.test(n)) return 'network'
  return 'internal'
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

const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p)
export function insideDirs(p, dirs, base) {
  const abs = norm(path.resolve(base ?? dirs[0] ?? '.', String(p)))
  return dirs.some(d => {
    const nd = norm(d)
    const rel = path.relative(nd, abs)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

// ---- agy 自己各段對話的資料夾（#2351；Rust 端 acp_policy.rs 的 inside_agy_conv_dir 同一套規則）----
// agy 把分析檔寫在 <家>/.gemini/antigravity-cli/brain/<對話編號>/ 底下；換班或重開後的新一段也要能改舊段寫的文件。
// 放行：brain/<合法編號>/<檔>（含 scratch）。不放行：直接寫在 brain 底下、對話資料夾本身、任一段的 .system_generated/、brain 以外（含 oauth_creds.json）
export const validConvId = s => typeof s === 'string' && s.length > 0 && s.length <= 100 && /^[A-Za-z0-9_-]+$/.test(s)
export function agyBrainDir(env = process.env) {
  const home = [env?.USERPROFILE, env?.HOME].find(v => typeof v === 'string' && v.trim()) ?? os.homedir()
  return path.join(home, '.gemini', 'antigravity-cli', 'brain')
}
// 解成實際位置：最深一層存在的上層用 realpath 解開捷徑與 junction，還不存在的部分接在後面
function realPathOf(base, p) {
  let cur = path.resolve(base, String(p))
  const rest = []
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest.reverse()) } catch { /* 往上一層 */ }
    const up = path.dirname(cur)
    if (up === cur) return null
    rest.push(path.basename(cur))
    cur = up
  }
}
export function insideAgyConvDir(paths, brain, base) {
  let realBrain
  try { realBrain = fs.realpathSync.native(brain) } catch { return false }
  if (!paths.length) return false
  return paths.every(p => {
    const real = realPathOf(base, p)
    if (!real) return false
    const rel = path.relative(norm(realBrain), norm(real))
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false
    const [id, first] = rel.split(path.sep)
    // Windows 會吃掉名字尾巴的點與空白（`.system_generated.` 開到同一個資料夾），先去掉再比
    const f = (first ?? '').replace(/[. ]+$/, '').toLowerCase()
    return validConvId(id) && f !== '' && f !== '.system_generated'
  })
}

// 請求：{ category, paths: string[] }。回傳 { verdict, reason }
export function decide(policy, { category, paths = [] }, base) {
  const rule = policy.rules[category] ?? policy.rules.other
  if (category === 'internal') return { verdict: 'allow', reason: '內部控制' }
  const outside = (category === 'read' || category === 'write') ? paths.filter(p => !insideDirs(p, policy.allowDirs, base)) : []
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
  const cmd = typeof tc.rawInput?.command === 'string' ? tc.rawInput.command : Array.isArray(tc.rawInput?.command) ? tc.rawInput.command.join(' ') : ''
  const what = cmd ? `指令：${clip(cmd, 160)}` : paths.length ? `檔案：${clip(paths[0], 160)}` : tc.title ? clip(tc.title, 160) : '（沒有說明）'
  return { category, paths: [...new Set(paths)], summary: `${categoryLabel(category)}：${what}` }
}

// agy tool_info.parameters → 路徑與摘要
export function describeAgyTool(toolName, parameters) {
  const category = categoryOfAgyTool(toolName)
  const p = parameters && typeof parameters === 'object' ? parameters : {}
  const paths = Object.entries(p).filter(([k, v]) => /(path|file|dir|target)/i.test(k) && typeof v === 'string' && v).map(([, v]) => v)
  const cmd = typeof p.CommandLine === 'string' ? p.CommandLine : typeof p.command === 'string' ? p.command : ''
  const what = cmd ? `指令：${clip(cmd, 160)}` : paths.length ? `檔案：${clip(paths[0], 160)}` : clip(toolName, 60)
  return { category, paths: [...new Set(paths)], summary: `${categoryLabel(category)}：${what}` }
}
