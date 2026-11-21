// 冒煙分片的總數守門（#1975）：四片各自只跑一部分情境，沒有人替「加起來是不是全部」把關，
// 一片漏跑一個、兩片重跑同一個、整片沒回報，每片單獨看都是綠的（假綠）。這支在彙總 job 檢查：
//   1. 每片都回報了清單（1..N 片各一份、不多不少、N 一致）
//   2. 各片宣稱的情境總數 = 目前程式裡實際的情境數
//   3. 各片實際跑的情境加起來 = 全部情境：沒有重複、沒有遺漏、沒有不認得的名稱
//   4. 空集合不算通過：沒有任何清單、或清單全空，一律紅
// 用法：node scripts/smoke-shard-gate.mjs <放各片清單的資料夾> --shards N
//   資料夾內（含子資料夾）每個名為 smoke-manifest.json 的檔都算一片的清單。結束碼：0 全部相符；1 有問題（逐條列出）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 清單格式：{ shard: i, of: N, total: 全部情境數, names: [本片實際跑的情境名…] } */
export const manifestProblems = m => {
  const p = []
  if (!m || typeof m !== 'object') return ['清單不是物件']
  if (!Number.isInteger(m.shard) || m.shard < 1) p.push('shard 不是正整數')
  if (!Number.isInteger(m.of) || m.of < 1) p.push('of 不是正整數')
  if (Number.isInteger(m.shard) && Number.isInteger(m.of) && m.shard > m.of) p.push('shard 大於 of')
  if (!Number.isInteger(m.total) || m.total < 1) p.push('total 不是正整數')
  if (!Array.isArray(m.names) || m.names.some(n => typeof n !== 'string' || !n)) p.push('names 不是情境名稱陣列')
  return p
}

/**
 * @param manifests 各片的清單（已解析的物件）
 * @param opts.shards 預期片數 N（workflow 的 matrix 大小）
 * @param opts.expectedNames 程式裡實際的全部情境名稱
 * @returns 問題清單；空陣列才是通過
 */
export const checkShards = (manifests, { shards, expectedNames }) => {
  const problems = []
  if (!Number.isInteger(shards) || shards < 1) return ['沒有指定預期片數（--shards N）']
  if (!Array.isArray(expectedNames) || !expectedNames.length) return ['程式裡沒有任何情境，守門無法比對']
  if (!Array.isArray(manifests) || !manifests.length) return ['沒有收到任何一片的清單（空集合不算通過）']

  const valid = []
  manifests.forEach((m, i) => {
    const bad = manifestProblems(m)
    if (bad.length) problems.push(`第 ${i + 1} 份清單格式不對：${bad.join('、')}`)
    else valid.push(m)
  })

  for (const m of valid) {
    if (m.of !== shards) problems.push(`第 ${m.shard} 片宣稱共 ${m.of} 片，與預期的 ${shards} 片不同`)
    if (m.total !== expectedNames.length) problems.push(`第 ${m.shard} 片宣稱全部有 ${m.total} 個情境，程式裡實際是 ${expectedNames.length} 個`)
  }

  const count = new Map()
  for (const m of valid) count.set(m.shard, (count.get(m.shard) ?? 0) + 1)
  for (let i = 1; i <= shards; i++) if (!count.has(i)) problems.push(`第 ${i} 片沒有回報清單（整片沒跑完或沒上傳）`)
  for (const [i, n] of count) {
    if (i > shards) problems.push(`多出第 ${i} 片的清單（預期只有 ${shards} 片）`)
    else if (n > 1) problems.push(`第 ${i} 片的清單出現 ${n} 份`)
  }

  const known = new Set(expectedNames)
  const seen = new Map()   // 情境名 -> 哪幾片跑了
  let ran = 0
  for (const m of valid) {
    for (const n of m.names) {
      ran++
      if (!known.has(n)) problems.push(`第 ${m.shard} 片跑了不認得的情境：${n}`)
      seen.set(n, [...(seen.get(n) ?? []), m.shard])
    }
  }
  if (valid.length && ran === 0) problems.push('所有片的情境清單都是空的（空集合不算通過）')
  for (const [n, who] of seen) if (who.length > 1) problems.push(`情境 ${n} 重複跑了（第 ${who.join('、')} 片）`)
  const missing = expectedNames.filter(n => !seen.has(n))
  if (missing.length) problems.push(`漏跑 ${missing.length} 個情境：${missing.join('、')}`)
  if (!problems.length && ran !== expectedNames.length) problems.push(`各片加總 ${ran} 個，應為 ${expectedNames.length} 個`)
  return problems
}

/** 資料夾（含子資料夾）裡每個 smoke-manifest.json 讀成一份清單；檔案壞掉就放一個 null，讓 checkShards 報格式不對 */
export const readManifests = dir => {
  if (!fs.existsSync(dir)) return []
  const files = fs.readdirSync(dir, { recursive: true }).map(String).filter(f => path.basename(f) === 'smoke-manifest.json')
  return files.map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return null } })
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = process.argv.slice(2)
  const dir = args.find(a => !a.startsWith('--'))
  const sArg = args.find(a => a.startsWith('--shards='))?.slice(9) ?? args[args.indexOf('--shards') + 1]
  const shards = Number(sArg)
  if (!dir || !Number.isInteger(shards) || shards < 1) { console.error('用法：node scripts/smoke-shard-gate.mjs <清單資料夾> --shards N'); process.exit(2) }
  const { SCENARIOS } = await import('./smoke-lib.mjs')
  const manifests = readManifests(dir)
  const problems = checkShards(manifests, { shards, expectedNames: SCENARIOS.map(s => s.name) })
  for (const m of manifests) if (m && Array.isArray(m.names)) console.log(`第 ${m.shard}/${m.of} 片：${m.names.length} 個情境`)
  if (problems.length) {
    console.error(`冒煙分片守門：不通過（${problems.length} 項）`)
    for (const x of problems) console.error(`  ✗ ${x}`)
    process.exit(1)
  }
  console.log(`冒煙分片守門：通過（${shards} 片加總 ${SCENARIOS.length} 個情境，無重複、無遺漏）`)
}
