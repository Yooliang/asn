// #2163 PR-3b 第三道證明：標記字串掃描。
// 帶 test-hooks 建置的執行檔裡會有標記（src-tauri/src/flags/test_var.rs 的 TEST_HOOKS_MARKER），正式安裝包裡一個位元組都不該有。
// 發版 CI 對正式 exe 要求「掃不到」、對 hooks 版 exe 要求「掃得到」：兩邊都驗，才不會因為標記被優化掉或編碼改了而假綠。
// 用法：node scripts/hooks-marker-scan.mjs --absent <正式 exe> --present <hooks 版 exe>（可重複給）
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** 標記字串。只准出現在這支腳本與測試；Rust 那邊只有 feature 開時才編進去（所以這個字面值不准寫進任何會編進 exe 的檔案） */
export const MARKER = 'ASN_TEST_HOOKS_ENABLED_MARKER'

/** 這份內容裡有沒有標記（Rust 的位元組字串是原樣 ASCII） */
export const hasMarker = buf => Buffer.from(buf).includes(Buffer.from(MARKER, 'ascii'))

/**
 * 驗一個檔案。expect 是 'absent'（正式包：不准有）或 'present'（hooks 版：一定要有）。
 * 回 { ok, message }；檔案讀不到、是空的一律算失敗（讀不到不能當成「沒有標記」）
 */
export function checkMarker(file, expect, readFile = f => fs.readFileSync(f)) {
  if (expect !== 'absent' && expect !== 'present') return { ok: false, message: `不認得的期望值：${expect}` }
  let buf
  try { buf = readFile(file) } catch (e) { return { ok: false, message: `讀不到 ${file}：${e.message}` } }
  if (!buf || buf.length === 0) return { ok: false, message: `${file} 是空的，不能當證據` }
  const found = hasMarker(buf)
  if (expect === 'absent') return found ? { ok: false, message: `${file} 掃到 test-hooks 標記：這個執行檔帶了測試掛鉤，不准發出去` } : { ok: true, message: `${file} 沒有標記（正式版，符合預期）` }
  return found ? { ok: true, message: `${file} 有標記（hooks 版，符合預期）` } : { ok: false, message: `${file} 掃不到標記：hooks 版沒帶標記，這道證明沒有對照組（可能被優化掉了），不能放行` }
}

/** 解析命令列：回 { checks: [{ file, expect }] } 或 { error } */
export function parseArgs(argv) {
  const checks = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--absent' || a === '--present') {
      const file = argv[++i]
      if (!file) return { error: `${a} 後面要接檔案` }
      checks.push({ file, expect: a.slice(2) })
    } else return { error: `不認得的參數：${a}` }
  }
  if (!checks.some(c => c.expect === 'absent') || !checks.some(c => c.expect === 'present')) return { error: '一定要同時給 --absent（正式 exe）與 --present（hooks 版 exe），只驗一邊會假綠' }
  return { checks }
}

export function main(argv = process.argv.slice(2)) {
  const p = parseArgs(argv)
  if (p.error) { console.error(`標記掃描：${p.error}`); return 2 }
  let bad = 0
  for (const c of p.checks) {
    const r = checkMarker(c.file, c.expect)
    console.log(`${r.ok ? '通過' : '失敗'}：${r.message}`)
    if (!r.ok) bad++
  }
  return bad === 0 ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main())
