// 自動上傳 AAB 到 Google Play 內部測試與封閉測試並發布（Google Play Developer API v3，androidpublisher）。
// 流程：edits.insert → edits.bundles.upload（只傳一次）→ 每條軌道各 edits.tracks.update（預設 internal、alpha；completed、zh-TW 更新說明）→ edits.commit（只一次）。
// 任何一步失敗就不 commit，並用 edits.delete 清掉半成品，不會出現一條軌道有、另一條沒有。
// 認證：Google 服務帳戶 JSON 金鑰（預設 %USERPROFILE%\.asn\play\play-service-account.json，可用 ASN_PLAY_SA_FILE 覆蓋），
// 用 node:crypto 簽 JWT（RS256）換存取權杖，不新增相依套件。金鑰只讀進記憶體，不印出、不寫 log；錯誤只帶 HTTP 狀態與 Google 的錯誤代碼。
// 用法：npm run publish:play（或 npm run release:play -- --upload，建置完接著上傳）。
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { changelogFirstSection } from './release-lib.mjs'
import { checkAboveMax } from './play-version.mjs'

export const PACKAGE_NAME = 'tw.yooliang.asn'
export const SCOPE = 'https://www.googleapis.com/auth/androidpublisher'
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const DEFAULT_BASE = 'https://androidpublisher.googleapis.com'
// 預設同時發內部測試（internal）與封閉測試（Play API 的軌道名是 alpha）。
// 為什麼預設兩條：測試人員改用 Google 群組管理，群組只能加在封閉測試；內部測試仍保留給開發者自己快速驗證。
export const DEFAULT_TRACKS = ['internal', 'alpha']
const TRACK_NAMES = { internal: '內部測試', alpha: '封閉測試' }
const trackLabel = t => TRACK_NAMES[t] ? `${TRACK_NAMES[t]}（${t}）` : t
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

// 設定軌道失敗：權限不夠或軌道不存在時給白話說明（做什麼、誰去哪裡處理）；技術代碼只寫 log，不放進訊息。
export const trackError = (track, status) => {
  const label = trackLabel(track)
  if (status === 401 || status === 403) return `服務帳戶沒有「${label}」軌道的發布權限，這次沒有發布任何軌道。請擁有者到 Play Console 的「使用者和權限」，替服務帳戶打開「發布到測試軌道」的權限後再重發。`
  if (status === 404) return `Play 找不到「${label}」軌道，這次沒有發布任何軌道。請擁有者到 Play Console 的「測試」頁面確認該測試軌道已建立（封閉測試要先建立一個軌道），再重發。`
  return `設定「${label}」軌道失敗，這次沒有發布任何軌道，請稍後重發；若持續失敗請查看上傳記錄。`
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

// 更新說明：CHANGELOG 最新一段，超過上限就截在整條結尾，下一行放「…」，不留半句。
// 第一條就超過上限（找不到換行）才截在字數上限。
export const releaseNotes = (changelog, version) => {
  const t = changelogFirstSection(changelog) || `ASN ${version} 更新`
  if (t.length <= NOTES_LIMIT) return t
  const end = t.lastIndexOf('\n', NOTES_LIMIT - 2)   // 含結尾的「\n…」兩個字元，總長不超過上限
  return end > 0 ? `${t.slice(0, end).trimEnd()}\n…` : `${t.slice(0, NOTES_LIMIT - 1)}…`
}

// 編輯裡列出 App 目前所有的 AAB（edits.bundles.list），回最大的 versionCode；一個都沒有回 null
const maxInEdit = async (call, app, id, auth) => {
  const r = await call('查詢現有版本', 'GET', `${app}/edits/${id}/bundles`, { headers: auth })
  const codes = (Array.isArray(r.bundles) ? r.bundles : []).map(b => Number(b.versionCode)).filter(Number.isFinite)
  return codes.length ? Math.max(...codes) : null
}

// 軌道名會拼進網址，只收小寫英文、數字、底線、減號（不合規在建編輯之前就擋下）
export const TRACK_RE = /^[a-z0-9_-]+$/
export const OPTIONAL_TRACK = 'alpha'   // 封閉測試：失敗不拖累其他軌道
export const checkTracks = list => {
  if (!Array.isArray(list) || !list.length) throw new Error('軌道清單不可為空')
  for (const t of list) if (typeof t !== 'string' || !TRACK_RE.test(t)) throw new Error('軌道名稱只能用小寫英文、數字、底線或減號（例如 internal、alpha）')
}
// 告警分類：permission（401/403）、notfound（404）、other（其他，例如送審中）。通知文字用這個代碼對照固定說明，不放原始錯誤
export const alphaFailKind = status => (status === 401 || status === 403 ? 'permission' : status === 404 ? 'notfound' : 'other')

class TrackFailure extends Error {
  constructor(track, status, message) { super(message); this.track = track; this.status = status; this.trackFailure = true }
}

// expectCode：這次 AAB 應該是的 versionCode（release-play.mjs 依 play-version.mjs 算的）。有給就先查 Play 上的最大值，
// 不比它大就不上傳；上傳後 Play 回的 versionCode 也要等於它，不然就不提交（AAB 和預期的不是同一份）
// 兩條軌道一起發（同一個編輯、只提交一次）；若失敗的是 alpha（封閉測試）且還有別的軌道，就刪掉這個編輯，
// 另開一個編輯只發其餘軌道並提交，結果的 alpha 欄位寫明沒發成與分類。其他軌道自己失敗＝整體失敗。
export const publishAab = async ({ aabFile, sa, notes, version = '', expectCode = null, packageName = PACKAGE_NAME, tracks = null, track = null, apiBase = DEFAULT_BASE, tokenUri, request = makeRequester(), log = () => {} }) => {
  // tracks 優先；舊參數 track（單一軌道）仍可用；都沒給就用預設兩條
  const trackList = [...new Set(tracks ?? (track ? [track] : DEFAULT_TRACKS))]
  checkTracks(trackList)
  const token = await getAccessToken(sa, request, tokenUri || sa.token_uri)
  const auth = { authorization: `Bearer ${token}` }
  const json = { ...auth, 'content-type': 'application/json' }
  const app = `${apiBase}/androidpublisher/v3/applications/${packageName}`
  const call = async (what, method, url, opt) => {
    const r = await request(method, url, opt)
    if (r.status < 200 || r.status >= 300) throw new Error(`${what}失敗（HTTP ${r.status}，${errCode(r.text)}）`)
    return r.text ? JSON.parse(r.text) : {}
  }
  // 一輪：建編輯 → 上傳 → 設各軌道 → 提交一次。失敗就刪編輯並丟錯（軌道設定失敗丟 TrackFailure）
  const attempt = async list => {
    log('建立編輯 …')
    const edit = await call('建立編輯', 'POST', `${app}/edits`, { headers: json, body: '{}' })
    const id = edit.id
    if (!id) throw new Error('建立編輯失敗（回應沒有編輯代號）')
    try {
      if (expectCode != null) {
        const max = await maxInEdit(call, app, id, auth)
        const bad = checkAboveMax(expectCode, max)
        if (bad) throw new Error(bad)
        log(`Play 上目前最大的 versionCode：${max ?? '（沒有）'}，這次是 ${expectCode}`)
      }
      const data = fs.readFileSync(aabFile)
      log(`上傳 AAB（${(data.length / 1048576).toFixed(1)} MB）…`)
      const up = await call('上傳 AAB', 'POST', `${apiBase}/upload/androidpublisher/v3/applications/${packageName}/edits/${id}/bundles?uploadType=media`, { headers: { ...auth, 'content-type': 'application/octet-stream' }, body: data })
      const versionCode = up.versionCode
      if (versionCode == null) throw new Error('上傳 AAB 失敗（回應沒有 versionCode）')
      if (expectCode != null && Number(versionCode) !== expectCode) throw new Error(`上傳的 AAB 是 versionCode ${versionCode}，不是預期的 ${expectCode}，不提交`)
      for (const t of list) {
        log(`設定 ${t} 軌道（versionCode ${versionCode}）…`)
        const body = JSON.stringify({ track: t, releases: [{ name: version || String(versionCode), versionCodes: [String(versionCode)], status: 'completed', releaseNotes: [{ language: 'zh-TW', text: notes }] }] })
        const r = await request('PUT', `${app}/edits/${id}/tracks/${t}`, { headers: json, body })
        if (r.status < 200 || r.status >= 300) {
          log(`設定 ${t} 軌道失敗：HTTP ${r.status}，${errCode(r.text)}`)   // 原始代碼只進 log
          throw new TrackFailure(t, r.status, trackError(t, r.status))
        }
      }
      log('提交 …')
      await call('提交編輯', 'POST', `${app}/edits/${id}:commit`, { headers: auth })
      return { versionCode: Number(versionCode), editId: id, tracks: list }
    } catch (e) {
      try { await request('DELETE', `${app}/edits/${id}`, { headers: auth }) } catch { /* 清不掉就算了，編輯會自己過期 */ }
      throw e
    }
  }
  try {
    const r = await attempt(trackList)
    return { ...r, alpha: trackList.includes(OPTIONAL_TRACK) ? { status: 'ok' } : null }
  } catch (e) {
    const rest = trackList.filter(t => t !== OPTIONAL_TRACK)
    if (!(e instanceof TrackFailure) || e.track !== OPTIONAL_TRACK || !rest.length) throw e
    log(`封閉測試沒發成（${alphaFailKind(e.status)}），改只發 ${rest.join('、')} …`)
    const r = await attempt(rest)
    return { ...r, alpha: { status: 'failed', kind: alphaFailKind(e.status), message: e.message } }
  }
}

// 只查不傳：建一個編輯、列出現有 AAB、刪掉編輯，回最大的 versionCode（release-play.mjs 建置前先檢查用）
// tracks 有給就順便用 edits.tracks.get 看每條軌道在不在；查不到只呼叫 warn（不算失敗，跟封閉測試降級邏輯一致）
export const maxPlayCode = async ({ sa, packageName = PACKAGE_NAME, apiBase = DEFAULT_BASE, tokenUri, request = makeRequester(), tracks = null, warn = () => {} }) => {
  if (tracks) checkTracks(tracks)
  const token = await getAccessToken(sa, request, tokenUri || sa.token_uri)
  const auth = { authorization: `Bearer ${token}` }
  const app = `${apiBase}/androidpublisher/v3/applications/${packageName}`
  const call = async (what, method, url, opt) => {
    const r = await request(method, url, opt)
    if (r.status < 200 || r.status >= 300) throw new Error(`${what}失敗（HTTP ${r.status}，${errCode(r.text)}）`)
    return r.text ? JSON.parse(r.text) : {}
  }
  const edit = await call('建立編輯', 'POST', `${app}/edits`, { headers: { ...auth, 'content-type': 'application/json' }, body: '{}' })
  if (!edit.id) throw new Error('建立編輯失敗（回應沒有編輯代號）')
  try {
    const max = await maxInEdit(call, app, edit.id, auth)
    for (const t of tracks || []) {
      const r = await request('GET', `${app}/edits/${edit.id}/tracks/${t}`, { headers: auth })
      if (r.status < 200 || r.status >= 300) warn(`查不到${trackLabel(t)}軌道（HTTP ${r.status}），發版時該軌道可能發不出去；請擁有者到 Play Console 確認軌道已建立、服務帳戶有權限。`)
    }
    return max
  } finally {
    try { await request('DELETE', `${app}/edits/${edit.id}`, { headers: auth }) } catch { /* 編輯會自己過期 */ }
  }
}

// CI 回報：alpha 結果寫進 $GITHUB_OUTPUT（給 notify 組通知）、annotation 與 step summary。只寫固定分類與白話說明，不寫原始錯誤。
export const reportAlpha = (alpha, env = process.env, out = console.log) => {
  if (!alpha) return
  const line = (f, t) => { if (f) fs.appendFileSync(f, t) }
  line(env.GITHUB_OUTPUT, `alpha_status=${alpha.status}
alpha_kind=${alpha.kind || ''}
`)
  if (alpha.status === 'failed') {
    out(`::warning title=play-alpha::${alpha.message}`)
    line(env.GITHUB_STEP_SUMMARY, `### play-alpha 告警
${alpha.message}

內部測試已照常發出。
`)
  }
}

const main = async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const arg = process.argv.find(a => a.startsWith('--aab='))
  const aab = arg ? arg.slice(6) : path.join(root, 'src-tauri', 'target', 'play', `ASN_${version}_play.aab`)
  const codeArg = process.argv.find(a => a.startsWith('--expect-code='))
  const expectCode = codeArg ? Number(codeArg.slice('--expect-code='.length)) : null
  const tracksArg = process.argv.find(a => a.startsWith('--tracks='))
  const tracks = tracksArg ? tracksArg.slice('--tracks='.length).split(',').map(x => x.trim()).filter(Boolean) : null
  const checkOnly = process.argv.includes('--check-only')
  try {
    if (codeArg && !Number.isInteger(expectCode)) throw new Error('--expect-code 要是整數')
    if (checkOnly) {
      if (expectCode == null) throw new Error('--check-only 要搭配 --expect-code')
      const max = await maxPlayCode({ sa: loadServiceAccount(defaultKeyFile()), tracks: tracks || DEFAULT_TRACKS, warn: m => { console.log(`::warning title=Play 軌道檢查::${m}`); console.log(m) } })
      const bad = checkAboveMax(expectCode, max)
      if (bad) throw new Error(bad)
      console.log(`Play 上目前最大的 versionCode：${max ?? '（沒有）'}，這次 ${expectCode} 可以用`)
      return
    }
    if (!fs.existsSync(aab)) throw new Error(`找不到要上傳的 AAB：${aab}\n請先執行 npm run release:play 建置。`)
    const sa = loadServiceAccount(defaultKeyFile())
    const notes = releaseNotes(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version)
    const r = await publishAab({ aabFile: aab, sa, notes, version, expectCode, tracks, log: m => console.log(m) })
    console.log(`已發布到 Play ${r.tracks.map(trackLabel).join('、')}：版本 ${version}（versionCode ${r.versionCode}）`)
    reportAlpha(r.alpha)
  } catch (e) {
    console.error(`上傳中止：${e.message}`)
    process.exit(1)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
