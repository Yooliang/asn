// CI 簽章後的驗證（#2022 ②-1）：包住 verify_sig.mjs，多做兩件 CI 才有的事。
//   1. 驗簽（含 verify_sig 內建的反向驗證）：公鑰從標籤上的 tauri.conf.json 讀，不信 CI 手上任何別處的公鑰
//   2. 這裡再獨立做一次反向驗證：在記憶體裡改安裝檔一個位元組，必須驗不過（不靠 verify_sig 內部那一份，免得它被改壞沒人發現）
//   3. 簽章前後安裝檔的 sha256 一致（--before-sha 是簽章之前、從 SHA256SUMS.txt 取得的值）
// 只讀檔、不碰金鑰、不印任何簽章內容。
// 用法：node tools/release/ci_verify_sig.mjs --conf <tauri.conf.json> --exe <安裝檔> --before-sha <64 位十六進位> [--sig <.sig，預設 <exe>.sig>]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { verifyAll, verifySig } from './verify_sig.mjs'

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')

/** 純函式：回 { ok, problems }；不碰檔案系統 */
export function ciVerify({ pubkeyText, sigText, fileBytes, expectedFileName, beforeSha }) {
  const problems = []
  if (!/^[0-9a-f]{64}$/.test(String(beforeSha ?? ''))) problems.push('簽章前的 sha256 不是 64 位小寫十六進位')
  problems.push(...verifyAll({ pubkeyText, sigText, fileBytes, expectedFileName }).problems)
  // 獨立的反向驗證：只有原樣驗得過才有意義，所以放在原樣驗過之後
  if (verifySig({ pubkeyText, sigText, fileBytes, expectedFileName }).ok && fileBytes.length > 0) {
    const tampered = Buffer.from(fileBytes)
    tampered[Math.floor(tampered.length / 2)] ^= 0x01
    if (verifySig({ pubkeyText, sigText, fileBytes: tampered, expectedFileName }).ok) problems.push('反向驗證失敗：安裝檔改了一個位元組，簽章居然還驗得過')
  }
  if (sha256(fileBytes) !== beforeSha) problems.push('簽章前後安裝檔的 sha256 不一致（簽章過程改動了安裝檔，或拿錯檔）')
  return { ok: problems.length === 0, problems }
}

export function main(argv = process.argv.slice(2), { readFile = p => fs.readFileSync(p), log = console.log } = {}) {
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const conf = arg('--conf'), exe = arg('--exe'), before = arg('--before-sha')
  const sig = arg('--sig') ?? (exe ? `${exe}.sig` : undefined)
  if (!conf || !exe || !before) { log('用法：--conf <tauri.conf.json> --exe <安裝檔> --before-sha <簽章前 sha256> [--sig <.sig>]'); return 2 }
  let r
  try {
    const pubkeyText = JSON.parse(readFile(conf).toString('utf8')).plugins.updater.pubkey
    r = ciVerify({ pubkeyText, sigText: readFile(sig).toString('utf8'), fileBytes: readFile(exe), expectedFileName: path.basename(exe), beforeSha: before })
  } catch (e) { log(`驗簽中止：${e.message}`); return 1 }
  if (!r.ok) { log(`CI 驗簽沒過（${r.problems.length} 項）：`); for (const p of r.problems) log(`- ${p}`); return 1 }
  log(`CI 驗簽通過（驗簽、反向驗證、簽章前後 sha256 一致）：${path.basename(exe)}`)
  return 0
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main())
