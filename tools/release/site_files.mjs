// latest.json／index.html 的產生與「版本不退」檢查（#2022 ②-2）：本機版（local_sign_publish.mjs 第 5、6 步）與 CI 版（ci_site_files.mjs）共用同一份，
// 避免兩份邏輯各改各的。純邏輯；唯一碰外面的是 fetchOnlineLatest（fetch 由呼叫端注入）。不碰金鑰。
// 這裡丟的 SiteFilesError 是「自己寫的訊息」：本機版會轉成 StepError（訊息會貼群組），CI 版直接印出。
import { buildLatestJson, installerUrl, patchDownloadLink, resolveNotes, INSTALLER_HREF_RE } from '../../relay/asn/scripts/release-lib.mjs'
import { sigMatchesLatest } from './verify_sig.mjs'

export const SITE_BASE = 'https://asnmessenger.web.app'

export class SiteFilesError extends Error {}
const bad = msg => { throw new SiteFilesError(msg) }

export const compareVersions = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

/**
 * 產 latest.json 與首頁：更新說明取 CHANGELOG 最新一段（同 resolveNotes）、signature 取 .sig 原文、
 * 電腦版只帶 windows-x86_64（#1964：舊的 Linux 項不能留）、首頁安裝檔連結換成這版。
 * 回 { notes, latest, latestText, indexText }；寫檔由呼叫端決定。
 */
export function buildSiteFiles({ version, sigText, changelog, indexHtml, pubDate, date }) {
  const { notes } = resolveNotes({ arg: '', changelog, version, date })
  const latest = buildLatestJson({ version, notes, pubDate, signature: sigText })
  const m = sigMatchesLatest({ sigText, latest })
  if (!m.ok) bad(m.problems.join('；'))
  const html = String(indexHtml).replace(/\r\n/g, '\n')
  if (!INSTALLER_HREF_RE.test(html)) bad('index.html 裡找不到安裝檔連結，不知道要改哪裡')
  INSTALLER_HREF_RE.lastIndex = 0
  return { notes, latest, latestText: `${JSON.stringify(latest, null, 2)}\n`, indexText: patchDownloadLink(html, installerUrl(version)) }
}

/** 讀線上 latest.json；回 { version, obj }。讀不到、格式不對都丟 SiteFilesError */
export async function fetchOnlineLatest({ fetchFn, now = () => Date.now(), base = SITE_BASE }) {
  let obj
  try {
    const res = await fetchFn(`${base}/update/latest.json?t=${now()}`, { headers: { 'cache-control': 'no-cache' } })
    if (!res.ok) bad(`讀不到線上 latest.json（HTTP ${res.status}）`)
    obj = JSON.parse(await res.text())
  } catch (e) { if (e instanceof SiteFilesError) throw e; bad('讀不到線上 latest.json，無法確認版本不退') }
  const version = obj?.version
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) bad('線上 latest.json 的 version 格式不對')
  return { version, obj }
}

/** 版本不退：低於線上一律擋；等於線上要 allowSame（本機要加 --same-version；CI 重跑同一版時允許）。回問題訊息或 null */
export function versionNotBackProblem({ version, online, allowSame }) {
  const c = compareVersions(version, online)
  if (c < 0) return `版本會倒退：這次 ${version}，線上已是 ${online}`
  if (c === 0 && !allowSame) return `線上已經是 ${version}：要重發同一版請加 --same-version`
  return null
}
