// 各支 *_sql.test.mjs 共用的 PGlite 輔助：
// 1. fastPGlite()：載入 PGlite，回傳「開新資料庫比較快」的版本（#1383）。
//    每個 new PGlite() 原本都要重新編譯約 9MB 的 WebAssembly、再跑一次 initdb 建空資料庫，一個約 0.7 秒，
//    而一項測試開一個，這就是 SQL 測試慢的主因。這裡每支測試檔只做一次：編譯好的模組留著重用，
//    第一次建好的空資料庫匯出成檔案（執行器有給共用快取目錄時整批只建一次），之後每個新資料庫直接從這份檔案載入
//    （內容跟 initdb 剛建好的一樣，彼此獨立、不共用狀態）。
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

/** 空資料庫的匯出檔：執行器（tools/run-root-tests.mjs）有給共用快取目錄（ROOT_TESTS_SHARED_DIR）就整批只建一次、各支讀同一份；
 *  檔名帶 PGlite 版本與檔案大小，換版自動重建；先寫暫存檔再改名，並行的幾支同時建也不會讀到寫一半的檔。這份檔只讀不改，不構成測試之間的共用狀態。
 *  沒有共用目錄（例如直接 node --test 單支）就在這支程序裡建一份。 */
async function seedDump(PGlite, base, dist) {
  const make = async () => { const seed = await PGlite.create(base); try { return await seed.dumpDataDir('none') } finally { await seed.close() } }
  const dir = process.env.ROOT_TESTS_SHARED_DIR
  if (!dir || !fs.existsSync(dir)) return make()
  const ver = JSON.parse(fs.readFileSync(path.join(dist, '..', 'package.json'), 'utf8')).version
  const sizes = ['pglite.wasm', 'initdb.wasm', 'pglite.data'].map(f => fs.statSync(path.join(dist, f)).size).join('-')
  const file = path.join(dir, `pglite-seed-${ver}-${sizes}.tar`)
  try { return new Blob([fs.readFileSync(file)]) } catch { /* 還沒有，下面建 */ }
  const blob = await make()
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, Buffer.from(await blob.arrayBuffer()))
    fs.renameSync(tmp, file)
  } catch { try { fs.rmSync(tmp, { force: true }) } catch { /* 留給執行器整個目錄一起刪 */ } }
  return blob
}

/** 載入 PGlite 並回傳加速版的類別；沒裝 PGlite 會丟錯（呼叫端照舊 catch 後略過實跑）。 */
export async function fastPGlite() {
  if (fastClass) return fastClass
  const { PGlite } = await import('@electric-sql/pglite')
  const dist = path.dirname(createRequire(import.meta.url).resolve('@electric-sql/pglite'))
  const [pgliteWasmModule, initdbWasmModule] = await Promise.all(['pglite.wasm', 'initdb.wasm'].map(f => WebAssembly.compile(fs.readFileSync(path.join(dist, f)))))
  const fsBundle = new Blob([fs.readFileSync(path.join(dist, 'pglite.data'))])
  const base = { pgliteWasmModule, initdbWasmModule, fsBundle }
  const fast = { ...base, loadDataDir: await seedDump(PGlite, base, dist) }
  fastClass = class FastPGlite extends PGlite {
    constructor(...args) { super(...(args.length ? args : [fast])) }
  }
  return fastClass
}
