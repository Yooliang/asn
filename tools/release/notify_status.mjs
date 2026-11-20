// 發版結果通知文字（#1892 規格 2.3）：純函式，輸入 { guardResult, auto, results }，輸出 { level, text }。
// results 以 job 代號為鍵，值為 success／failure／skipped／cancelled（缺的視為 skipped）。
// 文字只放 job 中文名、版本、本 repo 的 run／job 連結與固定的守門步驟名（都是常數或經格式驗證的值），絕不放 log 內容或錯誤原文：留言在公開 issue。
// level：success（全部完成）、info（略過）、warning（部分完成或被中止）、error（失敗或異常）。

export const JOBS = ['preflight-play', 'desktop', 'attest', 'site-draft', 'android-build', 'android-upload']
export const JOB_NAME = {
  guard: '標籤檢查',
  'preflight-play': 'Play 版號預檢',
  desktop: '電腦版建置與測試',
  attest: '安裝檔來源證明',
  'site-draft': '官網紀錄草稿',
  'android-build': 'Android 建置',
  'android-upload': 'Play 上傳',
}
// 每個 job 的上游（needs，不含 guard 以外的全體）；用來分辨「上游失敗造成的 skipped」
const NEEDS = {
  'preflight-play': ['guard'], desktop: ['guard'], attest: ['desktop'], 'site-draft': ['guard'],
  'android-build': ['guard', 'preflight-play'], 'android-upload': ['android-build'],
}

// repo variable ASN_RELEASE_AUTO：只有值恰為 true 才是 true（未設定、空字串、false、TRUE 都不是）
// 守門失敗時能寫進公開留言的步驟名：只收這幾個固定的字串（不收呼叫端給的任意文字）
export const GUARD_STEPS = ['標籤格式', '版本檔一致', '標籤在主分支上', '更新紀錄', '官網紀錄預檢', '發佈狀態', '同時有別的發版']

// 連結只收本 repo 的 Actions 執行頁（run 或 job），不收查詢字串、片段與其他網域
export const RUN_URL_RE = /^https:\/\/github\.com\/Yooliang\/asn\/actions\/runs\/[0-9]+(\/job\/[0-9]+)?$/

export const autoEnabled = value => value === true || value === 'true'

const names = list => list.map(j => JOB_NAME[j]).join('、')

// jobs：這次 workflow 實際有的 job（預設全部）；只有電腦版與官網時不帶 Play 三個 job，文字就不提 Play
export function notifyStatus({ guardResult, auto, results = {}, version, runUrl, jobUrls = {}, guardStep, jobs: jobList = JOBS } = {}) {
  const JOBS_IN = JOBS.filter(j => jobList.includes(j))
  const withPlay = JOBS_IN.some(j => j === 'preflight-play' || j.startsWith('android-'))
  const v = typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? `v${version}` : ''
  const safeUrl = u => (typeof u === 'string' && RUN_URL_RE.test(u) ? u : '')
  const link = runUrl => (safeUrl(runUrl) ? `\nrun：${safeUrl(runUrl)}` : '')
  const jobLinks = jobs => jobs.filter(j => safeUrl(jobUrls[j])).map(j => `\n${JOB_NAME[j]}：${safeUrl(jobUrls[j])}`).join('')
  const done = j => (results[j] ?? 'skipped')
  const tail = link(runUrl)
  const head = v ? `${v}：` : ''
  const mk = (level, body, jobs = []) => ({ level, text: `${body}${jobLinks(jobs)}${tail}` })

  // 守門本身
  if (guardResult === 'failure') {
    const step = GUARD_STEPS.includes(guardStep) ?`（卡在：${guardStep}）` : ''
    return mk('error', `【發版未開始】${head}標籤檢查沒過${step}。沒有建置、沒有上傳`, ['guard'])
  }
  if (guardResult === 'cancelled') return mk('warning', `【發版中止】${head}run 被取消，已完成：無`)
  if (guardResult !== 'success') return mk('error', `【發版異常】${head}標籤檢查沒有成功也沒有失敗（${JOB_NAME.guard}結果不明）`)
  if (!autoEnabled(auto)) return mk('info', `【發版略過】${head}自動發版開關未開，請走手動備援`)

  const failed = JOBS_IN.filter(j => done(j) === 'failure')
  const cancelled = JOBS_IN.filter(j => done(j) === 'cancelled')
  const succeeded = JOBS_IN.filter(j => done(j) === 'success')

  // skipped 成因：上游（遞迴）有失敗或被取消才算「被上游連累」，其餘不明
  const explained = j => NEEDS[j].some(u => u !== 'guard' && (done(u) === 'failure' || done(u) === 'cancelled' || (done(u) === 'skipped' && explained(u))))
  const unexplained = JOBS_IN.filter(j => done(j) === 'skipped' && !explained(j))
  const cancelNote = cancelled.length ? `\n另有被取消：${names(cancelled)}` : ''
  const oddNote = unexplained.length ? `\n另有不明的略過：${names(unexplained)}` : ''

  if (failed.length === 0) {
    if (cancelled.length) return mk('warning', `【發版中止】${head}run 被取消，已完成：${succeeded.length ? names(succeeded) : '無'}${unexplained.length ? oddNote : ''}`)
    if (unexplained.length) return mk('error', `【發版異常】${head}上游沒失敗、開關也沒關卻被略過：${names(unexplained)}`)
    return mk('success', `【CI 完成】${head}${withPlay ? '未簽章安裝檔與 Play internal 已就緒' : '未簽章安裝檔已就緒'}，尚未上線。CI 好了，14 天內要簽`)
  }

  const desktopFail = ['desktop', 'attest'].filter(j => failed.includes(j))
  const androidFail = ['preflight-play', 'android-build', 'android-upload'].filter(j => failed.includes(j))
  const draftFail = failed.includes('site-draft')
  const desktopOk = done('desktop') === 'success' && done('attest') === 'success'
  const playUploaded = done('android-upload') === 'success'
  const playText = playUploaded ? '已上傳' : '未上傳'
  const playPart = withPlay ? `；Play ${playText}` : ''
  const extras = `${draftFail && (desktopFail.length || androidFail.length) ? `\n另外：${JOB_NAME['site-draft']}也沒產出` : ''}${cancelNote}${oddNote}`
  const jobs = failed

  if (desktopFail.length && androidFail.length) {
    return mk('error', `【發版失敗】${head}兩邊都失敗\n電腦版：卡在${names(desktopFail)}\nPlay：卡在${names(androidFail)}${extras}`, jobs)
  }
  if (desktopFail.length) {
    return mk('error', `【發版失敗】${head}電腦版失敗（卡在${names(desktopFail)}）${playPart}${extras}`, jobs)
  }
  if (androidFail.includes('preflight-play')) {
    const desk = desktopOk ? '成功' : '未完成'
    return mk('error', `【發版失敗】${head}Play 未上傳（版號預檢）；電腦版${desk}${androidFail.length > 1 ? `\n另外：${names(androidFail.filter(j => j !== 'preflight-play'))}也失敗` : ''}${extras}`, jobs)
  }
  if (androidFail.length) {
    const upload = androidFail.includes('android-upload')
    const playLine = upload ? 'Play 上傳失敗，可能已部分上傳；重跑前先到 Play Console 確認（辦法見 2.6）' : 'Play 未上傳；重跑辦法見 2.6'
    return mk('warning', `【部分完成】${head}電腦版${desktopOk ? '就緒' : '未完成'}、${playLine}${extras}`, jobs)
  }
  // 只有官網紀錄草稿失敗
  return mk('warning', `【發版部分完成】${head}電腦版${desktopOk ? '就緒' : '未完成'}；官網紀錄草稿沒產出${withPlay ? `（Play ${playText}${playUploaded ? '，同版不可重傳' : ''}）` : ''}。本機腳本用 --items-file 提供人工修過的內容，仍過同一檢查${extras}`, jobs)
}
