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
export const ROOM_READ_LAST = 50
export const MAX_READ_BYTES = 256 * 1024
// 一筆最壞的總耗時：讀群組兩次、gh 最多 GH_CALLS_MAX 次、送出一次
export const WORST_CASE_ITEM_MS = 2 * READ_TIMEOUT_MS + GH_CALLS_MAX * GH_TIMEOUT_MS + SEND_TIMEOUT_MS

// ---- 固定句
export const POST_FAILED_FIXED = '群組通知沒貼出去，發版收尾時請由發版視窗跑 --post-pending'
export const EXPIRED_FIXED = '有待貼項目超過 48 小時沒貼出去，已移到 .expired 檔、不再代貼，請人工確認'

export const PLATFORM_NAME = { desktop: '電腦版', linux: 'Linux 版' }
const KIND_LABEL = { published: '已發佈通知', 'ci-failed': '打包失敗回報', blocked: '等人工處理回報', 'dryrun-failed': '試跑失敗回報', 'publish-failed': '正式發佈失敗回報' }
const KIND_WHAT = { 'ci-failed': '打包流程沒有成功', blocked: '等人工處理，不會自動發佈', 'dryrun-failed': '試跑失敗，不會自動重試', 'publish-failed': '正式發佈失敗，不會自動重試' }
export const labelOf = (item) => `${PLATFORM_NAME[item.platform]} v${item.version} ${KIND_LABEL[item.kind]}`

// 認得「這則已經貼過」的開頭（結尾帶分隔符，避免 v0.2.9 誤認 v0.2.99）。
// 已發佈通知沿用發版腳本原本的開頭，人工補貼過的也認得
export function signatureOf(item) {
  if (item.kind === 'published') return item.platform === 'linux' ? `【Linux 版發版完成】v${item.version}：` : `【發版完成】v${item.version}：`
  return `【發版回報】${PLATFORM_NAME[item.platform]} v${item.version}：${KIND_WHAT[item.kind]}。`
}
export function composeMessage(item) {
  const sig = signatureOf(item)
  if (item.kind === 'published') return `${sig}${PLATFORM_NAME[item.platform]}已發佈，commit ${item.commit}。`
  return `${sig}commit ${item.commit}。`
}

// ---- 群組設定檔：只在代貼端自己的資料夾，路徑寫死、不接受命令列或環境變數改
export const CONFIG_DIR = 'asn-post-config'
export const CONFIG_FILE = 'post-room.json'
export const CONFIG_MAX_BYTES = 1024
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/
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
  try {
    const text = deps.readFile(configPath)
    if (Buffer.byteLength(text, 'utf8') > CONFIG_MAX_BYTES) return { ok: false, msg: `群組設定檔太大或格式不對，請重新建立 ${configPath}，內容 {"v":1,"room":"群組代號"}` }
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

// ---- 群組內容比對
// 回 { ok:true, found } 或 { ok:false }（讀不到或格式不認得，呼叫端不送）
export function roomHas(item, room, deps) {
  let r
  try { r = deps.asnCli(['room', '--room-read', room, '--last', String(ROOM_READ_LAST), '--json']) } catch { return { ok: false } }
  if (!r || r.status !== 0 || typeof r.stdout !== 'string' || Buffer.byteLength(r.stdout, 'utf8') > MAX_READ_BYTES) return { ok: false }
  let rows
  try { const j = JSON.parse(r.stdout); rows = Array.isArray(j) ? j : j?.messages } catch { return { ok: false } }
  if (!Array.isArray(rows)) return { ok: false }
  const sig = signatureOf(item)
  return { ok: true, found: rows.some((m) => typeof m?.body === 'string' && m.body.includes(sig)) }
}
