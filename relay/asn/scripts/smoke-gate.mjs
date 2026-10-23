// 發版關卡：打包前先跑啟動冒煙測試（scripts/smoke-ui.mjs），沒過就中止發版。
// --skip-smoke 可跳過（會印醒目警告）。三支發版腳本共用。
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const SKIP_FLAG = '--skip-smoke'
export const SKIP_WARNING = '!!! 警告：已用 --skip-smoke 跳過啟動冒煙測試。沒有人檢查過畫面能不能掛上，白畫面的版本可能被發出去。 !!!'

// 把 --skip-smoke 從參數拿掉（各腳本自己的參數解析不認得它）
export const splitSkipFlag = argv => ({ skip: argv.includes(SKIP_FLAG), rest: argv.filter(a => a !== SKIP_FLAG) })

// 回傳 { ok, skipped }；跑不過時呼叫端中止。run 可注入（測試用）
export const smokeGate = ({ root, skip, run = spawnSync, node = process.execPath, log = console }) => {
  if (skip) {
    const bar = '!'.repeat(SKIP_WARNING.length)
    log.warn(`\n${bar}\n${SKIP_WARNING}\n${bar}\n`)
    return { ok: true, skipped: true }
  }
  log.log('發版前先跑啟動冒煙測試（npm run smoke:ui）…')
  const r = run(node, [path.join(root, 'scripts', 'smoke-ui.mjs')], { cwd: root, stdio: 'inherit' })
  return { ok: r.status === 0, skipped: false }
}
