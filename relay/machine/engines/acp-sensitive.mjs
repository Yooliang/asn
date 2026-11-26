// 讀取的敏感位置判定（#2356 PR-2，Node 版）。與電腦版 relay/asn/src-tauri/src/bridge/engines/acp_sensitive.rs 同一套規則、同一份清單
// （清單與參數在 relay/shared/sensitive-roots.json）。規則：背景夥伴可以讀這台電腦上的檔，但登入資料、金鑰、各 AI 工具的設定與對話記錄不行。
// 判定本身只做路徑解析（解開捷徑），不讀檔案內容；acp-policy.mjs 的 decide（標準 ACP）與 acp-worker.mjs 的 checkTool（agy）呼叫它。
// 比對的是路徑，不是邊界：執行指令的內容不經這裡。已知限制：大小寫不分的檔案系統（例如 macOS 預設）上，只有 Windows 會把比對轉成小寫。
import { insideAgyConvDir, validConvId } from './acp-brain.mjs'
import { HOST_KEY_DIR, IS_WIN, MAX_PATH_LEN, SHARED_HOME_NAMES, SYSTEM_FILES, byteLen, trimWs } from './acp-sensitive-data.mjs'
import { isExempt } from './acp-sensitive-exempt.mjs'
import { containerLike } from './acp-sensitive-extract.mjs'
import {
  driveRelative, expand, foldPath, hasDotDot, joinBase, nstr, opaqueDevicePath, realPathWith, stripFileUrl, wildcardPrefix, winClean,
} from './acp-sensitive-path.mjs'
import { ReadTool } from './acp-sensitive-roots.mjs'

export { extractReadPaths, paramKeys } from './acp-sensitive-extract.mjs'
export { ATTACHMENTS_READABLE, rootsForWorker, validName, withWorkdirs } from './acp-sensitive-exempt.mjs'
export { ReadTool, buildRoots, homesFrom, readToolOfAcpKind, readToolOfAgy } from './acp-sensitive-roots.mjs'

/** 判定結果：可以讀、落在敏感位置、解析不了（偏向擋） */
export const ReadVerdict = Object.freeze({ Allow: 'allow', Sensitive: 'sensitive', Unresolvable: 'unresolvable' })

const isAncestorOf = (f, root) => root.startsWith(`${f}/`)

function isHostKey(f) {
  const k = f.lastIndexOf('/')
  if (k < 0) return false
  const n = f.slice(k + 1)
  return f.slice(0, k) === HOST_KEY_DIR && n.startsWith('ssh_host_') && n.endsWith('_key')
}

/** `/proc/<編號>/environ` */
function isProcEnviron(f) {
  if (!f.startsWith('/proc/')) return false
  const rest = f.slice(6)
  const k = rest.indexOf('/')
  return k > 0 && rest.slice(k + 1) === 'environ'
}

/** 別人的家目錄：`/root`，以及家目錄所在資料夾（`/home`、`C:\Users`…）底下不是自己家的子資料夾（共用的 Public 等不算） */
function otherHomeHit(f, tool, roots) {
  const recursive = tool === ReadTool.Recursive
  const mine = p => roots.homes.includes(p)
  if ((f === '/root' || f.startsWith('/root/')) && !mine('/root')) return true
  for (const parent of roots.otherHomeParents) {
    if (recursive && (f === parent || isAncestorOf(f, parent))) return true
    if (!f.startsWith(`${parent}/`)) continue
    const name = f.slice(parent.length + 1).split('/')[0]
    if (name !== '' && !SHARED_HOME_NAMES.includes(name) && !mine(`${parent}/${name}`)) return true
  }
  return false
}

/** 這個（已正規化的）位置算不算命中：等於或在敏感根底下；遞迴類工具再加上「是敏感根的上層」 */
function hits(f, tool, roots) {
  const recursive = tool === ReadTool.Recursive
  for (const r of roots.roots) {
    if (f === r || f.startsWith(`${r}/`)) return true
    if (recursive && isAncestorOf(f, r)) return true
  }
  // 檔名前綴：資料夾底下以前綴開頭的檔
  for (const [dir, pre] of roots.prefixFiles) {
    const k = f.lastIndexOf('/')
    const inDir = k >= 0 && f.slice(0, k) === dir && f.slice(k + 1).startsWith(pre)
    if (inDir || (recursive && (f === dir || isAncestorOf(f, dir)))) return true
  }
  if (isHostKey(f) || isProcEnviron(f) || SYSTEM_FILES.includes(f)) return true
  if (recursive) {
    const procPid = f.startsWith('/proc/') && !f.slice(6).includes('/')
    if (f === HOST_KEY_DIR || isAncestorOf(f, HOST_KEY_DIR) || f === '/proc' || isAncestorOf(f, '/proc') || procPid || SYSTEM_FILES.some(s => isAncestorOf(f, s))) return true
  }
  return otherHomeHit(f, tool, roots)
}

const underHome = (f, roots) => roots.homes.some(h => f === h || f.startsWith(`${h}/`))

/** agy 自己的對話資料夾：裡面的檔放行；對話資料夾本身與 brain 本身只開給單檔與列舉（遞迴搜尋會掃進系統目錄，照擋） */
function exemptBrain(f, roots, base, tool) {
  return roots.brains.some(b => {
    if (insideAgyConvDir([f], b, base)) return true
    if (tool === ReadTool.Recursive) return false
    const forms = [nstr(b)]
    const real = realPathWith(roots.canon, b)
    if (real !== null) forms.push(nstr(real))
    return forms.some(d => f === d || (f.startsWith(`${d}/`) && validConvId(f.slice(d.length + 1))))
  })
}

const tryCanon = (canon, p) => { try { return canon(p) } catch { return null } }

/**
 * 這條讀取路徑是不是敏感位置。ctx：{ roots, base, tool }。
 * 每個展開結果各取三種形式比對（字面折疊、原字串的實際位置、折疊後的實際位置），任一命中就擋；
 * agy 自己的對話資料夾（brain/<編號>/，不含系統目錄）與明確放行的資料夾例外，且每個命中的形式都要各自符合例外才放行。
 * 解析不了（含展開不了的變數）而字面落在使用者資料夾底下，偏向擋
 */
export function readVerdict(pathRaw, ctx) {
  const raw = trimWs(String(pathRaw ?? ''))
  if (raw === '') return ReadVerdict.Allow
  // 超長或含換行的路徑欄位：沒辦法逐段判定，偏向擋
  if (byteLen(pathRaw) > MAX_PATH_LEN || /[\n\r\0]/.test(pathRaw)) return ReadVerdict.Unresolvable
  // 層數超過上限、還沒解開的巢狀 JSON 字串（抽取時原樣收進來的）：沒辦法判定，偏向擋
  if (containerLike(raw)) return ReadVerdict.Unresolvable
  const { roots, base } = ctx
  const baseTool = ctx.tool ?? ReadTool.Single
  const [cands, expandFailed] = expand(stripFileUrl(raw), roots.homePaths, roots.env)
  let failed = expandFailed
  const literals = []
  for (const c0 of cands) {
    if (IS_WIN && (opaqueDevicePath(c0, roots.localNames) || driveRelative(c0))) return ReadVerdict.Unresolvable
    const cleaned = IS_WIN ? winClean(c0, roots.localNames) : c0
    // 清理過的形式也要看：磁碟機後面不接分隔符的寫法，在接上工作資料夾之前就擋下
    if (IS_WIN && driveRelative(cleaned)) return ReadVerdict.Unresolvable
    // 路徑段有萬用字元：取第一個萬用字元之前的部分，照遞迴搜尋判定
    const wp = wildcardPrefix(cleaned)
    const c = wp ?? cleaned
    const tool = wp === null ? baseTool : ReadTool.Recursive
    const joined = joinBase(base, c)
    const dotdot = hasDotDot(joined)
    const folded = foldPath(base, c)
    // （形式, 可不可以套例外）：含 .. 的字面形式不套例外
    const forms = [[nstr(folded), !dotdot]]
    const canonJoined = tryCanon(roots.canon, joined)
    if (canonJoined !== null) forms.push([nstr(canonJoined), true])
    // 展開後的原字串（沒做過任何清理）也直接解一次
    if (cleaned !== c0 && wildcardPrefix(c0) === null) {
      const p = tryCanon(roots.canon, joinBase(base, c0))
      if (p !== null) forms.push([nstr(p), true])
    }
    const rp = realPathWith(roots.canon, folded)
    if (rp !== null) forms.push([nstr(rp), !dotdot])
    else failed = true
    literals.push(nstr(folded), nstr(joined))
    for (const [f, mayExempt] of forms) {
      if (hits(f, tool, roots) && !(mayExempt && (isExempt(roots, f) || exemptBrain(f, roots, base, tool)))) return ReadVerdict.Sensitive
    }
  }
  return failed && literals.some(l => underHome(l, roots)) ? ReadVerdict.Unresolvable : ReadVerdict.Allow
}

export const isSensitiveRead = (pathRaw, ctx) => readVerdict(pathRaw, ctx) !== ReadVerdict.Allow
