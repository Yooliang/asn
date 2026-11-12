// 各支 *_sql.test.mjs 共用：把 new PGlite() 開的資料庫登記起來，每項測試跑完就關掉（整支跑完再保險關一次）。
// 為什麼要關：沒 close 的 PGlite 每個實例都留著一個約 10 秒才到期的計時器，測試本身幾秒跑完，node 程序卻要多等 10 秒左右才退出（#1379）。
// 為什麼每項測試完就關、不等整支跑完（#1383）：每個實例約佔 100～200MB，整支跑完才關的話一支測試檔可以吃到 5GB 以上；
//   CI（4 核、16GB）並行 4 支時就把記憶體吃光、開始換頁，並行完全沒有加速。
// 要跨測試共用的資料庫（例如 tenants_sql 的「已上線」資料庫）用 keepUntilEnd(db) 標起來，整支跑完才關。
// 為什麼由各檔本體呼叫 closeAtEnd()：node:test 的 afterEach／after 要在測試檔本體（不是被 import 的模組載入當下）掛，才會套到該檔的測試。
import { after, afterEach } from 'node:test'

const perTest = []
const shared = []

export function track(db) {
  perTest.push(db)
  return db
}

/** 這個資料庫要給後面的測試繼續用：不在這項測試結束時關，整支跑完才關 */
export function keepUntilEnd(db) {
  const i = perTest.indexOf(db)
  if (i >= 0) perTest.splice(i, 1)
  if (!shared.includes(db)) shared.push(db)
  return db
}

const closeEach = list => Promise.allSettled(list.splice(0).map(db => db.close()))

export function closeAtEnd() {
  afterEach(() => closeEach(perTest))
  after(async () => { await closeEach(perTest); await closeEach(shared) })
}
