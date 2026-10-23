// 自動上傳 AAB 到 Google Play 內部測試並發布（Google Play Developer API v3，androidpublisher）。
// 流程：edits.insert → edits.bundles.upload → edits.tracks.update（internal、completed、zh-TW 更新說明）→ edits.commit。
// 任何一步失敗就不 commit，並用 edits.delete 清掉半成品。
// 認證：Google 服務帳戶 JSON 金鑰（預設 %USERPROFILE%\.asn\play\play-service-account.json，可用 ASN_PLAY_SA_FILE 覆蓋），
// 用 node:crypto 簽 JWT（RS256）換存取權杖，不新增相依套件。金鑰只讀進記憶體，不印出、不寫 log；錯誤只帶 HTTP 狀態與 Google 的錯誤代碼。
// 用法：npm run publish:play（或 npm run release:play -- --upload，建置完接著上傳）。
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { changelogFirstSection } from './release-lib.mjs'

export const PACKAGE_NAME = 'tw.yooliang.asn'
export const SCOPE = 'https://www.googleapis.com/auth/androidpublisher'
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const DEFAULT_BASE = 'https://androidpublisher.googleapis.com'
const NOTES_LIMIT = 500   // Play 每種語言的更新說明上限

export const defaultKeyFile = () => process.env.ASN_PLAY_SA_FILE || path.join(os.homedir(), '.asn', 'play', 'play-service-account.json')

// 讀服務帳戶金鑰（只回傳需要的欄位）。找不到或格式不對就丟出純中文說明，且不含檔案內容。
export const loadServiceAccount = file => {
  if (!fs.existsSync(file)) {
    throw new Error(`找不到 Play 服務帳戶金鑰：${file}\n請依 docs/design/ANDROID.md「自動上傳 Play」建立服務帳戶與 JSON 金鑰，放到上面這個位置；或用環境變數 ASN_PLAY_SA_FILE 指定檔案路徑。`)
  }
  let j
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new Error(`Play 服務帳戶金鑰不是有效的 JSON：${file}`) }
  if (!j || typeof j.client_email !== 'string' || typeof j.private_key !== 'string') {
    throw new Error(`Play 服務帳戶金鑰缺少必要欄位（client_email、private_key）：${file}`)
  }
  return { client_email: j.client_email, private_key: j.private_key, token_uri: typeof j.token_uri === 'string' ? j.token_uri : DEFAULT_TOKEN_URI }
}

const b64u = b => Buffer.from(b).toString('base64url')
export const makeJwt = (sa, nowSec = Math.floor(Date.now() / 1000), tokenUri = sa.token_uri) => {
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64u(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat: nowSec, exp: nowSec + 3600 }))
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claim}`), sa.private_key).toString('base64url')
  return `${head}.${claim}.${sig}`
}

// Google 錯誤回應只取代碼（error.status／errors[0].reason，或 OAuth 的 error 欄位），不帶訊息全文。
const errCode = text => {
  try {
    const e = JSON.parse(text)
    if (typeof e.error === 'string') return e.error
    return e.error?.errors?.[0]?.reason || e.error?.status || String(e.error?.code ?? '') || '未知'
  } catch { return '未知' }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// 帶逾時與重試的請求；只重試網路錯誤與 5xx。回傳 { status, text }。
export const makeRequester = ({ fetchFn = globalThis.fetch, timeoutMs = 120000, retries = 3, backoffMs = 1000 } = {}) => async (method, url, { headers = {}, body } = {}) => {
  let last
  for (let i = 0; i <= retries; i++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const r = await fetchFn(url, { method, headers, body, signal: ac.signal })
      const text = await r.text()
      if (r.status >= 500 && i < retries) { last = `HTTP ${r.status}`; await sleep(backoffMs * (i + 1)); continue }
      return { status: r.status, text }
    } catch (e) {
      last = e?.name === 'AbortError' ? '逾時' : '網路錯誤'
      if (i < retries) { await sleep(backoffMs * (i + 1)); continue }
    } finally { clearTimeout(timer) }
  }
  throw new Error(`連線失敗（${last}）`)
}

export const getAccessToken = async (sa, request, tokenUri = sa.token_uri) => {
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: makeJwt(sa, undefined, tokenUri) }).toString()
  const r = await request('POST', tokenUri, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  if (r.status !== 200) throw new Error(`取得存取權杖失敗（HTTP ${r.status}，${errCode(r.text)}）`)
  const t = JSON.parse(r.text).access_token
  if (!t) throw new Error('取得存取權杖失敗（回應沒有權杖）')
  return t
}

// 更新說明：CHANGELOG 最新一段，超過上限就截斷。
export const releaseNotes = (changelog, version) => {
  const t = changelogFirstSection(changelog) || `ASN ${version} 更新`
  return t.length > NOTES_LIMIT ? `${t.slice(0, NOTES_LIMIT - 1)}…` : t
}

export const publishAab = async ({ aabFile, sa, notes, version = '', packageName = PACKAGE_NAME, track = 'internal', apiBase = DEFAULT_BASE, tokenUri, request = makeRequester(), log = () => {} }) => {
  const token = await getAccessToken(sa, request, tokenUri || sa.token_uri)
  const auth = { authorization: `Bearer ${token}` }
  const json = { ...auth, 'content-type': 'application/json' }
  const app = `${apiBase}/androidpublisher/v3/applications/${packageName}`
  const call = async (what, method, url, opt) => {
    const r = await request(method, url, opt)
    if (r.status < 200 || r.status >= 300) throw new Error(`${what}失敗（HTTP ${r.status}，${errCode(r.text)}）`)
    return r.text ? JSON.parse(r.text) : {}
  }
  log('建立編輯 …')
  const edit = await call('建立編輯', 'POST', `${app}/edits`, { headers: json, body: '{}' })
  const id = edit.id
  if (!id) throw new Error('建立編輯失敗（回應沒有編輯代號）')
  try {
    const data = fs.readFileSync(aabFile)
    log(`上傳 AAB（${(data.length / 1048576).toFixed(1)} MB）…`)
    const up = await call('上傳 AAB', 'POST', `${apiBase}/upload/androidpublisher/v3/applications/${packageName}/edits/${id}/bundles?uploadType=media`, { headers: { ...auth, 'content-type': 'application/octet-stream' }, body: data })
    const versionCode = up.versionCode
    if (versionCode == null) throw new Error('上傳 AAB 失敗（回應沒有 versionCode）')
    log(`設定 ${track} 軌道（versionCode ${versionCode}）…`)
    await call('設定測試軌道', 'PUT', `${app}/edits/${id}/tracks/${track}`, { headers: json, body: JSON.stringify({ track, releases: [{ name: version || String(versionCode), versionCodes: [String(versionCode)], status: 'completed', releaseNotes: [{ language: 'zh-TW', text: notes }] }] }) })
    log('提交 …')
    await call('提交編輯', 'POST', `${app}/edits/${id}:commit`, { headers: auth })
    return { versionCode: Number(versionCode), editId: id }
  } catch (e) {
    try { await request('DELETE', `${app}/edits/${id}`, { headers: auth }) } catch { /* 清不掉就算了，編輯會自己過期 */ }
    throw e
  }
}

const main = async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const arg = process.argv.find(a => a.startsWith('--aab='))
  const aab = arg ? arg.slice(6) : path.join(root, 'src-tauri', 'target', 'play', `ASN_${version}_play.aab`)
  try {
    if (!fs.existsSync(aab)) throw new Error(`找不到要上傳的 AAB：${aab}\n請先執行 npm run release:play 建置。`)
    const sa = loadServiceAccount(defaultKeyFile())
    const notes = releaseNotes(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version)
    const r = await publishAab({ aabFile: aab, sa, notes, version, log: m => console.log(m) })
    console.log(`已發布到 Play 內部測試：版本 ${version}（versionCode ${r.versionCode}）`)
  } catch (e) {
    console.error(`上傳中止：${e.message}`)
    process.exit(1)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
