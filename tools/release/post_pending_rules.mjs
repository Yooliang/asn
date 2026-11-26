// 代貼子命令（--post-pending，#2345）用的固定規則：常數、文案模板、群組設定檔、GitHub 檢查、群組內容比對。
// 這裡所有會輸出或貼群組的文字都只由「驗證過的固定欄位」加固定句組成，不使用待貼檔裡的任何自由文字，也不使用外部指令的輸出原文。
import path from 'node:path'
import { REPO } from './github_release.mjs'

// ---- 時間常數（毫秒）
// 認領逾時必須大於「一筆從頭到尾最壞要花的時間」，否則別人會在我還在貼的時候接手
export const SEND_TIMEOUT_MS = 2 * 60 * 1000
export const READ_TIMEOUT_MS = 60 * 1000
export const GH_TIMEOUT_MS = 30 * 1000
export const GH_CALLS_MAX = 4
export const CLAIM_TIMEOUT_MS = 10 * 60 * 1000
export const MAX_AGE_MS = 48 * 60 * 60 * 1000
export const MAX_PER_RUN = 4
// 讀群組最近幾則；asn-cli 的上限是 200（room.rs 的 MAX_LAST），群組在這個範圍內沒有同則才當作沒貼過
export const ROOM_READ_LAST = 200
export const MAX_READ_BYTES = 256 * 1024
// 一筆最壞的總耗時：讀群組兩次、gh 最多 GH_CALLS_MAX 次、送出一次
export const WORST_CASE_ITEM_MS = 2 * READ_TIMEOUT_MS + GH_CALLS_MAX * GH_TIMEOUT_MS + SEND_TIMEOUT_MS

// ---- 固定句
export const POST_FAILED_FIXED = '群組通知沒貼出去，發版收尾時請由發版視窗跑 --post-pending'
export const PENDING_WRITE_FAILED_FIXED = '有一筆群組通知沒貼成、也沒能寫進待貼佇列，--post-pending 補貼不到它，請人工補貼'
export const BAD_CLAIM_FIXED = '有待貼項目的認領時間比現在還晚，已當成認領逾時處理，請人工確認'
export const EXPIRED_FIXED = '有待貼項目超過 48 小時沒貼出去，已移到 .expired 檔、不再代貼，請人工確認'

export const PLATFORM_NAME = { desktop: '電腦版', linux: 'Linux 版' }
const KIND_LABEL = { published: '已發佈通知', 'ci-failed': '打包失敗回報', blocked: '等人工處理回報', 'dryrun-failed': '試跑失敗回報', 'publish-failed': '正式發佈失敗回報' }
const KIND_WHAT = { 'ci-failed': '打包流程沒有成功', blocked: '等人工處理，不會自動發佈', 'dryrun-failed': '試跑失敗，不會自動重試', 'publish-failed': '正式發佈失敗，不會自動重試' }
export const labelOf = (item) => `${PLATFORM_NAME[item.platform]} v${item.version} ${KIND_LABEL[item.kind]}`

// 文案的固定開頭（結尾帶分隔符，避免 v0.2.9 誤認 v0.2.99）
export function signatureOf(item) {
  if (item.kind === 'published') return item.platform === 'linux' ? `【Linux 版發版完成】v${item.version}：` : `【發版完成】v${item.version}：`
  return `【發版回報】${PLATFORM_NAME[item.platform]} v${item.version}：${KIND_WHAT[item.kind]}。`
}
export function composeMessage(item) {
  const sig = signatureOf(item)
  if (item.kind === 'published') return `${sig}${PLATFORM_NAME[item.platform]}已發佈，commit ${item.commit}。`
  return `${sig}commit ${item.commit}。`
}
// 判斷「這則已經貼過」要整段開頭相符（含平台、版號、commit 8 碼），不是只看有沒有包含簽名。
// 舊貼法（local_sign_publish、linux_publish 原本的發版完成訊息）：開頭不同、commit 在句尾（Linux 舊文沒有 commit），也要繼續認得
const LEGACY_HEAD = {
  desktop: (v) => `【發版完成】v${v}：安裝檔已發 GitHub Release`,
  linux: (v) => `【Linux 版發版完成】v${v}：AppImage、deb 已附加到 GitHub Release`,
}
// Linux 舊文沒有 commit，只比開頭，所以另外要求訊息時間在 MAX_AGE_MS 內（recent ＝ 這則訊息夠新）
export function isPostedBody(item, body, recent = false) {
  if (body.startsWith(composeMessage(item))) return true
  if (item.kind !== 'published') return false
  if (!body.startsWith(LEGACY_HEAD[item.platform](item.version))) return false
  return item.platform === 'linux' ? recent === true : body.includes(`commit ${item.commit}`)
}
// 群組每則的 at（ISO 時間）在 now 之前、且不超過 MAX_AGE_MS 才算夠新；缺少、格式不對、未來一律不算
export function isRecentAt(at, nowMs) {
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(at)) return false
  const t = Date.parse(at)
  return Number.isFinite(t) && t <= nowMs && nowMs - t <= MAX_AGE_MS
}

// ---- 群組設定檔：只在代貼端自己的資料夾，路徑寫死、不接受命令列或環境變數改
export const CONFIG_DIR = 'asn-post-config'
export const CONFIG_FILE = 'post-room.json'
export const CONFIG_MAX_BYTES = 1024
const ROOM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
// 來源只有一個：%LOCALAPPDATA% 底下。拿不到就回 null（不退而求其次去讀家目錄）
export const defaultConfigPath = (env = process.env) => (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, CONFIG_DIR, CONFIG_FILE) : null)
export const NO_LOCALAPPDATA_MSG = '找不到這台電腦的 LOCALAPPDATA 位置，沒辦法讀群組設定檔，所以不貼。請在登入的使用者帳號下執行（群組設定檔固定放在 LOCALAPPDATA 底下的 asn-post-config 資料夾）'
const sameDir = (a, b) => path.resolve(path.dirname(a)).toLowerCase() === path.resolve(path.dirname(b)).toLowerCase()
export const configHelp = (p) => `還沒有設定要貼的群組。請建立檔案 ${p}，內容 {"v":1,"room":"群組代號"}（這個檔不能放在待貼佇列的同一個資料夾）`

// 回 { ok:true, room } 或 { ok:false, msg }；msg 只有固定句與程式自己算出的路徑
export function loadRoom(configPath, pendingPath, deps) {
  if (!configPath) return { ok: false, msg: NO_LOCALAPPDATA_MSG }
  if (sameDir(configPath, pendingPath)) return { ok: false, msg: `群組設定檔不能和待貼佇列放在同一個資料夾，請改放到 ${defaultConfigPath(deps.env) ?? 'LOCALAPPDATA 底下的 asn-post-config 資料夾'}` }
  if (!deps.exists(configPath)) return { ok: false, msg: configHelp(configPath) }
  let doc
  const tooBig = { ok: false, msg: `群組設定檔太大或格式不對，請重新建立 ${configPath}，內容 {"v":1,"room":"群組代號"}` }
  try {
    // 先用 stat 擋大小，太大的檔不讀進記憶體
    if (typeof deps.fileSize === 'function' && deps.fileSize(configPath) > CONFIG_MAX_BYTES) return tooBig
    const text = deps.readFile(configPath)
    if (Buffer.byteLength(text, 'utf8') > CONFIG_MAX_BYTES) return tooBig
    doc = JSON.parse(text)
  } catch { return { ok: false, msg: `群組設定檔讀不懂，請重新建立 ${configPath}，內容 {"v":1,"room":"群組代號"}` } }
  const keys = doc && typeof doc === 'object' && !Array.isArray(doc) ? Object.keys(doc).sort().join(',') : ''
  if (keys !== 'room,v' || doc.v !== 1 || typeof doc.room !== 'string' || !ROOM_RE.test(doc.room)) return { ok: false, msg: `群組設定檔格式不對，請重新建立 ${configPath}，內容 {"v":1,"room":"群組代號"}` }
  return { ok: true, room: doc.room }
}

// ---- GitHub 檢查（用現有的 gh 包裝，不另開網路入口）
const SHA40 = /^[0-9a-f]{40}$/
const ghJson = (deps, args) => {
  let r
  try { r = deps.gh(args, { timeout: GH_TIMEOUT_MS }) } catch { return null }
  if (!r || r.status !== 0) return null
  try { return JSON.parse(r.stdout) } catch { return null }
}
export const tagOfItem = (item) => (item.platform === 'linux' ? `linux-v${item.version}` : `v${item.version}`)
export const releaseTagOf = (item) => `v${item.version}`
export function requiredAssets(item) {
  const v = item.version
  return item.platform === 'linux' ? [`ASN_${v}_amd64.AppImage`, `ASN_${v}_amd64.AppImage.sig`, `ASN_${v}_amd64.deb`] : [`ASN_${v}_x64-setup.exe`, `ASN_${v}_x64-setup.exe.sig`]
}

// 標籤指到的 commit：輕量標籤 type 直接是 commit；註解標籤要再查一層（type 是 tag）才拿到 commit；其他一律當查不到
function tagCommit(deps, tag) {
  const ref = ghJson(deps, ['api', `repos/${REPO}/git/ref/tags/${tag}`])
  const o = ref?.object
  if (!o || typeof o.sha !== 'string' || !SHA40.test(o.sha)) return null
  if (o.type === 'commit') return o.sha
  if (o.type !== 'tag') return null
  const t = ghJson(deps, ['api', `repos/${REPO}/git/tags/${o.sha}`])
  const p = t?.object
  if (!p || p.type !== 'commit' || typeof p.sha !== 'string' || !SHA40.test(p.sha)) return null
  return p.sha
}

// 回 { ok:true } 或 { ok:false, why }（why 是固定句）
// 已發佈通知：標籤、Release（公開、非草稿、非預發行）、資產都要在；失敗回報：只確認標籤與 commit（那一版本來就沒有 Release）
export function checkGithub(item, deps) {
  const sha = tagCommit(deps, tagOfItem(item))
  if (!sha) return { ok: false, why: 'GitHub 上找不到對應的標籤' }
  if (!sha.startsWith(item.commit)) return { ok: false, why: '標籤指向的 commit 與紀錄不符' }
  if (item.kind !== 'published') return { ok: true }
  const rel = ghJson(deps, ['release', 'view', releaseTagOf(item), '--repo', REPO, '--json', 'tagName,isDraft,isPrerelease,assets'])
  if (!rel || rel.tagName !== releaseTagOf(item)) return { ok: false, why: 'GitHub 上找不到對應的 Release' }
  if (rel.isDraft !== false || rel.isPrerelease !== false) return { ok: false, why: 'Release 還不是正式公開的狀態' }
  const names = new Set(Array.isArray(rel.assets) ? rel.assets.map((a) => a?.name) : [])
  if (!requiredAssets(item).every((n) => names.has(n))) return { ok: false, why: 'Release 裡缺這個平台的安裝檔' }
  return { ok: true }
}

// ---- 自己的身分
// 用 `asn-cli send --whoami`（不寄信，只印判定結果；send.rs、caller.rs 的 whoami）。輸出裡兩行：
//   判定（行程鏈）：pid=<數字> name=<視窗名>　（判不到時是「判定（行程鏈）：無」，再看「判定（環境變數備援）：」同格式）
//   機器節點判定：<節點>　（失敗時是「機器節點判定失敗：…」）
// 群組讀出來每則的 from 是「<節點>~<視窗名>」（room.rs：my_key ＝ format!("{}~{}", node, name)）。
// 回「節點~視窗名」，拿不到（指令失敗、格式不認得、視窗沒名字）回 null，呼叫端當成讀不到、不送
// 代貼端解析 --whoami 輸出依賴的固定字串（行首）。caller.rs 的 whoami 一改文字，契約測試會紅，要同步改這裡（另見 #2372）
export const WHOAMI_CHAIN_PREFIX = '判定（行程鏈）：'
export const WHOAMI_ENV_PREFIX = '判定（環境變數備援）：'
export const WHOAMI_NODE_PREFIX = '機器節點判定：'
export const WHOAMI_PID_KEY = 'pid='
export const WHOAMI_NAME_KEY = 'name='
export const WHOAMI_NO_NAME = '(無名)'
const WHO_BAD =/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u
export function selfFrom(deps) {
  let r
  try { r = deps.asnCli(['send', '--whoami']) } catch { return null }
  if (!r || r.status !== 0 || typeof r.stdout !== 'string' || Buffer.byteLength(r.stdout, 'utf8') > MAX_READ_BYTES) return null
  const text = r.stdout.replace(/\r\n/g, '\n')
  const nameOf = (prefix) => new RegExp(`^${prefix}${WHOAMI_PID_KEY}\\d+ ${WHOAMI_NAME_KEY}(.+)$`, 'm').exec(text)?.[1]
  const name = nameOf(WHOAMI_CHAIN_PREFIX) ?? nameOf(WHOAMI_ENV_PREFIX)
  const node = new RegExp(`^${WHOAMI_NODE_PREFIX}(.+)$`, 'm').exec(text)?.[1]
  const clean = (s) => (typeof s === 'string' ? s.trim() : '')
  const n = clean(name), nd = clean(node)
  if (!n || !nd || n === WHOAMI_NO_NAME || WHO_BAD.test(n) || WHO_BAD.test(nd) || nd.includes('~')) return null
  return `${nd}~${n}`
}

// ---- 群組內容比對
// 只認自己這個身分（from ＝ me）發的、開頭整段相符的那則；別人貼的同一句不算。
// 回 { ok:true, found } 或 { ok:false }（讀不到、身分拿不到或格式不認得，呼叫端不送）
export function roomHas(item, room, me, deps) {
  if (typeof me !== 'string' || me === '') return { ok: false }
  let r
  try { r = deps.asnCli(['room', '--room-read', room, '--last', String(ROOM_READ_LAST), '--json']) } catch { return { ok: false } }
  if (!r || r.status !== 0 || typeof r.stdout !== 'string' || Buffer.byteLength(r.stdout, 'utf8') > MAX_READ_BYTES) return { ok: false }
  // 實際輸出（relay/asn/src-tauri/src/cli/room.rs 的 json_line）：每則一行 JSON 物件，沒有外層陣列；
  // 欄位 seq、from、from_name、trust、at、mentions、body（有標示時多 from_label，有附件時多 attachments）；沒有訊息時輸出是空的
  const rows = []
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let m
    try { m = JSON.parse(line) } catch { return { ok: false } }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.body !== 'string') return { ok: false }
    rows.push(m)
  }
  const nowMs = deps.now()
  return { ok: true, found: rows.some((m) => m.from === me && isPostedBody(item, m.body, isRecentAt(m.at, nowMs))) }
}
