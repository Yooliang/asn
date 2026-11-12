// 各支 *_sql.test.mjs 共用：把 new PGlite() 開的資料庫登記起來，整支測試檔跑完後一併關掉。
// 為什麼要關：沒 close 的 PGlite 每個實例都留著一個約 10 秒才到期的計時器，測試本身幾秒跑完，node 程序卻要多等 10 秒左右才退出（#1379）。
// 為什麼由各檔本體呼叫 closeAtEnd()：node:test 的 after 要在測試檔本體（不是被 import 的模組載入當下）掛，才會等到全部測試跑完才執行。
import { after } from 'node:test'

const opened = []

export function track(db) {
  opened.push(db)
  return db
}

export function closeAtEnd() {
  after(async () => { await Promise.allSettled(opened.splice(0).map(db => db.close())) })
}
