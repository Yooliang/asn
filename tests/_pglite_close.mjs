// 各支 *_sql.test.mjs 共用的 PGlite 輔助：
// 1. fastPGlite()：載入 PGlite，回傳「開新資料庫比較快」的版本（#1383）。
//    每個 new PGlite() 原本都要重新編譯約 9MB 的 WebAssembly、再跑一次 initdb 建空資料庫，一個約 0.7 秒，
//    而一項測試開一個，這就是 SQL 測試慢的主因。這裡每支測試檔只做一次：編譯好的模組留著重用，
//    第一次建好的空資料庫匯出成檔案，之後每個新資料庫直接從這份檔案載入（內容跟 initdb 剛建好的一樣，彼此獨立、不共用狀態）。
//    new PGlite() 有帶參數（指定資料夾、選項）的就照原樣交給 PGlite，不套用這些。
// 2. track()／closeAtEnd()：把開的資料庫登記起來，每項測試跑完就關掉（整支跑完再保險關一次）。
//    為什麼要關：沒 close 的 PGlite 每個實例都留著一個約 10 秒才到期的計時器，測試本身幾秒跑完，node 程序卻要多等 10 秒左右才退出（#1379）。
//    為什麼每項測試完就關、不等整支跑完（#1383）：每個實例約佔 100～200MB，整支跑完才關的話一支測試檔可以吃到 5GB 以上。
//    要跨測試共用的資料庫（例如 tenants_sql 的「已上線」資料庫）用 keepUntilEnd(db) 標起來，整支跑完才關。
//    為什麼由各檔本體呼叫 closeAtEnd()：node:test 的 afterEach／after 要在測試檔本體（不是被 import 的模組載入當下）掛，才會套到該檔的測試。
import { after, afterEach } from 'node:test'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

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

let fastClass = null

/** 載入 PGlite 並回傳加速版的類別；沒裝 PGlite 會丟錯（呼叫端照舊 catch 後略過實跑）。 */
export async function fastPGlite() {
  if (fastClass) return fastClass
  const { PGlite } = await import('@electric-sql/pglite')
  const dist = path.dirname(createRequire(import.meta.url).resolve('@electric-sql/pglite'))
  const [pgliteWasmModule, initdbWasmModule] = await Promise.all(['pglite.wasm', 'initdb.wasm'].map(f => WebAssembly.compile(fs.readFileSync(path.join(dist, f)))))
  const fsBundle = new Blob([fs.readFileSync(path.join(dist, 'pglite.data'))])
  const base = { pgliteWasmModule, initdbWasmModule, fsBundle }
  const seed = await PGlite.create(base)
  const loadDataDir = await seed.dumpDataDir('none')
  await seed.close()
  const fast = { ...base, loadDataDir }
  fastClass = class FastPGlite extends PGlite {
    constructor(...args) { super(...(args.length ? args : [fast])) }
  }
  return fastClass
}
