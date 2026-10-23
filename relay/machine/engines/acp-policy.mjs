// ACP 工作者的權限政策（純函式，不碰檔案、不碰行程，方便測試）。
// 政策＝每個「類別」一個決定 allow／deny／ask，外加「白名單資料夾」（有路徑的請求，路徑在白名單外一律拒絕）。
//   read     讀檔、搜尋、思考         預設 allow
//   write    寫檔、刪檔、搬檔         預設 allow（有路徑的請求以白名單資料夾為界，預設只有工作資料夾）
//   execute  執行指令                 預設 allow（指令沒有路徑可查，邊界只靠工作資料夾與明寫設定）
//   network  上網抓網頁、搜尋         預設 allow（只讀資訊；要全封閉就設 deny）
//   other    分不出類別的請求         預設 deny
// ask＝問人：轉接器把請求摘要寄給指定的人，等回覆（見 acp-approvals.mjs）；逾時一律當拒絕。
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

// 請求：{ category, paths: string[] }。回傳 { verdict, reason }
export function decide(policy, { category, paths = [] }, base) {
  const rule = policy.rules[category] ?? policy.rules.other
  if (category === 'internal') return { verdict: 'allow', reason: '內部控制' }
  const outside = (category === 'read' || category === 'write') ? paths.filter(p => !insideDirs(p, policy.allowDirs, base)) : []
  if (outside.length) return { verdict: 'deny', reason: `路徑在白名單資料夾之外：${outside[0]}` }
  return { verdict: rule, reason: `${categoryLabel(category)}的政策是 ${rule}` }
}

// ---- 摘要（要寄給人看的，不含機密）-----------------------------------------------------------------------------
const SECRET_RE = /(sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[\w-]{15,}\.[\w-]{8,}\.[\w-]{8,}|(?:authorization\s*[=:]\s*)?Bearer\s+\S+|(?:api[_-]?key|token|secret|password|passwd|authorization)\s*[=:]\s*\S+)/gi
export function redact(s) { return String(s ?? '').replace(SECRET_RE, '［已遮蔽］') }
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
