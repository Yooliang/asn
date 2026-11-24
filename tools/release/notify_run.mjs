// 發版 workflow 的 notify job 用的薄 CLI（#1892 規格 2.3）：把 needs 的結果交給純函式 notify_status.mjs，
// 產出一段文字，寫進 --out 指定的檔（給 gh issue comment --body-file 用）與 $GITHUB_STEP_SUMMARY。
// 輸入全走環境變數：NEEDS_JSON（toJSON(needs)）、RUN_URL、GUARD_STEP（guard 卡在哪一步的中文名，選填）。
// 文字只含 job 中文名、版本與 run 連結；不貼 log、不貼錯誤原文（留言在公開 issue）。
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ALL_JOBS, notifyStatus } from './notify_status.mjs'

/** needs 物件（job 代號 → { result, outputs }）轉成 notifyStatus 的輸入；缺的 job 視為 skipped */
export function statusFromNeeds(needs, { runUrl, guardStep } = {}) {
  const n = needs && typeof needs === 'object' ? needs : {}
  // 只傳實際在 needs 裡的 job：這一版沒有 Play，缺的 job 不算「不明的略過」
  const jobs = ALL_JOBS.filter(j => j in n)
  const results = Object.fromEntries(jobs.map(j => [j, n[j]?.result]))
  return notifyStatus({
    guardResult: n.guard?.result,
    auto: n.guard?.outputs?.auto,
    results,
    jobs,
    version: n.guard?.outputs?.version,
    runUrl,
    guardStep,
    playAlpha: n['android-upload']?.outputs?.alpha_status ? { status: n['android-upload'].outputs.alpha_status, kind: n['android-upload'].outputs.alpha_kind } : undefined,
  })
}

export function main(argv = process.argv.slice(2), env = process.env, {
  writeFile = (p, t) => fs.writeFileSync(p, t),
  appendFile = (p, t) => fs.appendFileSync(p, t),
  log = console.log,
} = {}) {
  const i = argv.indexOf('--out')
  const out = i >= 0 ? argv[i + 1] : undefined
  if (!out) { log('用法：--out <檔案>（環境變數：NEEDS_JSON、RUN_URL、GUARD_STEP）'); return 2 }
  let needs
  try { needs = JSON.parse(env.NEEDS_JSON ?? '') } catch { log('NEEDS_JSON 不是有效的 JSON'); return 1 }
  const r = statusFromNeeds(needs, { runUrl: env.RUN_URL, guardStep: env.GUARD_STEP })
  writeFile(out, `${r.text}\n`)
  if (env.GITHUB_STEP_SUMMARY) appendFile(env.GITHUB_STEP_SUMMARY, `${r.text}\n`)
  log(`通知等級：${r.level}`)
  return 0
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main())
