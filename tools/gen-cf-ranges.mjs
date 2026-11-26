// #2353：產生 Unicode「格式字元」（\p{Cf}）的連續區間，給 SQL 的 name 檢查用。
// 只輸出到 stdout（不寫檔）：一行 PostgreSQL 字元類的內容，每個區間寫成 \UXXXXXXXX 或 \UXXXXXXXX-\UXXXXXXXX。
// 用法：node tools/gen-cf-ranges.mjs
// 流程：已套用的 migration 不能回頭改。tests/launcher_models_sql.test.mjs 會檢查「最新一支定義 relay.sanitize_launcher_models 的 migration」
// 的 Cf 區間有沒有涵蓋 Node 的 \p{Cf}（涵蓋即可，SQL 多擋無害）。測試紅燈時：用本腳本產生新區間，
// 另寫一支新的 migration（create or replace relay.sanitize_launcher_models），不要改舊檔。
// 資料來自執行這支腳本的 Node 所帶的 Unicode 版本（process.versions.unicode）。
const CF = /\p{Cf}/u

export function cfRanges() {
  const ranges = []
  let start = -1
  for (let cp = 0; cp <= 0x10ffff + 1; cp++) {
    // 孤立代理碼（D800～DFFF）不是 Cf；String.fromCodePoint 對它們也能用
    const hit = cp <= 0x10ffff && CF.test(String.fromCodePoint(cp))
    if (hit && start < 0) start = cp
    if (!hit && start >= 0) { ranges.push([start, cp - 1]); start = -1 }
  }
  return ranges
}

const hex = cp => '\\U' + cp.toString(16).padStart(8, '0')

export function cfClassBody() {
  return cfRanges().map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join('')
}

// 直接執行（不是被 import）才印出
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  process.stdout.write(cfClassBody() + '\n')
  process.stderr.write(`unicode ${process.versions.unicode}, ranges ${cfRanges().length}\n`)
}
