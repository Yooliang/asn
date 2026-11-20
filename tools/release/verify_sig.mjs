// 更新簽章驗證（#1892 規格 2.5 第 4 步）：用 node:crypto 驗 Tauri updater 的 minisign 簽章，並做反向驗證。
// 底稿是 asn雯 在 0.2.35／0.2.36 實跑過的驗簽腳本，改成純函式：吃文字與位元組、回 { ok, problems }，不碰檔案系統、不印金鑰。
//
// 格式（tauri.conf.json 的 plugins.updater.pubkey 與 .sig 檔都是 base64 外殼，解開才是 minisign 文字）：
//   公鑰：第 1 行 untrusted comment；第 2 行 base64（'Ed'(2) + 金鑰 ID(8) + 公鑰(32) = 42 位元組）
//   簽章：第 1 行 untrusted comment；第 2 行 base64（演算法(2) + 金鑰 ID(8) + 簽章(64) = 74 位元組）；
//         第 3 行 "trusted comment: <文字>"；第 4 行 base64（全域簽章 64 位元組）
//   (a) 演算法標記必須是 'ED'（預雜湊）：先對檔案做 BLAKE2b-512，再對雜湊值做 Ed25519；標記是 'Ed'（直接簽整個檔）一律失敗
//   (b) 全域簽章：對「簽章 64 位元組 + trusted comment 的位元組（不含前綴）」做 Ed25519
//   trusted comment 是 Tab 分隔的欄位（timestamp:… file:… version:…），其中 file: 必須等於安裝檔名
// 用法：node tools/release/verify_sig.mjs --conf <tauri.conf.json> --exe <安裝檔> --sig <.sig> [--latest <latest.json>]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const PLATFORM = 'windows-x86_64'

// 嚴格的 base64 解碼：不是標準 base64（含空白、換行、缺補齊）就回 null，不像 Buffer.from 一樣默默略過壞字元
function strictBase64(text) {
  const s = String(text ?? '').trim()
  if (!s || !/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 !== 0) return null
  const buf = Buffer.from(s, 'base64')
  return buf.toString('base64') === s ? buf : null
}

const lines = text => String(text).trim().split(/\r?\n/)

// 解外殼的 minisign 公鑰文字 → { keyId, key, problems }
export function parsePubkey(pubkeyText) {
  const problems = []
  const shell = strictBase64(pubkeyText)
  if (!shell) return { keyId: null, key: null, problems: ['公鑰不是 base64 外殼'] }
  const ls = lines(shell.toString('utf8'))
  const raw = ls.length >= 2 ? strictBase64(ls[1]) : null
  if (!raw) return { keyId: null, key: null, problems: ['公鑰外殼解開後不是兩行的 minisign 公鑰文字'] }
  if (raw.length !== 42) problems.push(`公鑰長度是 ${raw.length} 位元組，應為 42`)
  else if (raw.subarray(0, 2).toString('latin1') !== 'Ed') problems.push(`公鑰演算法標記不是 Ed：${JSON.stringify(raw.subarray(0, 2).toString('latin1'))}`)
  if (problems.length) return { keyId: null, key: null, problems }
  const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw.subarray(10)]), format: 'der', type: 'spki' })
  return { keyId: Buffer.from(raw.subarray(2, 10)), key, problems }
}

// 解外殼的 .sig 文字 → { alg, keyId, sig, trusted, globalSig, problems }
export function parseSig(sigText) {
  const shell = strictBase64(sigText)
  if (!shell) return { problems: ['.sig 不是 base64 外殼'] }
  const ls = lines(shell.toString('utf8'))
  if (ls.length !== 4) return { problems: [`.sig 外殼解開後應為 4 行，實際 ${ls.length} 行`] }
  const sigRaw = strictBase64(ls[1])
  const globalSig = strictBase64(ls[3])
  const problems = []
  if (!sigRaw || sigRaw.length !== 74) problems.push('簽章行不是 74 位元組（演算法 2＋金鑰 ID 8＋簽章 64）')
  if (!ls[2].startsWith('trusted comment: ')) problems.push('第 3 行不是 trusted comment')
  if (!globalSig || globalSig.length !== 64) problems.push('全域簽章不是 64 位元組')
  if (problems.length) return { problems }
  return {
    alg: sigRaw.subarray(0, 2).toString('latin1'),
    keyId: Buffer.from(sigRaw.subarray(2, 10)),
    sig: Buffer.from(sigRaw.subarray(10)),
    trusted: ls[2].slice('trusted comment: '.length),
    globalSig: Buffer.from(globalSig),
    problems: [],
  }
}

const blake = buf => crypto.createHash('blake2b512').update(buf).digest()
const verifyFileSig = (key, sig, bytes) => crypto.verify(null, blake(bytes), key, sig)
const verifyGlobalSig = (key, sig, trusted, globalSig) => crypto.verify(null, Buffer.concat([sig, Buffer.from(trusted, 'utf8')]), key, globalSig)

// trusted comment 以 Tab 分欄；回 file: 欄的值（沒有回 null）
export function trustedFile(trusted) {
  for (const f of String(trusted).split('\t')) if (f.startsWith('file:')) return f.slice(5)
  return null
}

/** 驗簽：{ pubkeyText（tauri.conf.json 的 pubkey）, sigText（.sig 原文）, fileBytes, expectedFileName } → { ok, problems } */
export function verifySig({ pubkeyText, sigText, fileBytes, expectedFileName }) {
  const pub = parsePubkey(pubkeyText)
  const sg = parseSig(sigText)
  const problems = [...pub.problems.map(p => `公鑰：${p}`), ...sg.problems.map(p => `簽章：${p}`)]
  if (problems.length) return { ok: false, problems }
  if (sg.alg !== 'ED') problems.push(`簽章演算法標記必須是預雜湊的 ED，實際是 ${JSON.stringify(sg.alg)}`)
  if (!sg.keyId.equals(pub.keyId)) problems.push('簽章的金鑰 ID 和公鑰不同')
  if (!Buffer.isBuffer(fileBytes) || fileBytes.length === 0) problems.push('安裝檔是空的')
  if (problems.length) return { ok: false, problems }
  if (!verifyFileSig(pub.key, sg.sig, fileBytes)) problems.push('檔案簽章驗不過（BLAKE2b-512 預雜湊後的 Ed25519）')
  if (!verifyGlobalSig(pub.key, sg.sig, sg.trusted, sg.globalSig)) problems.push('trusted comment 的全域簽章驗不過')
  const name = trustedFile(sg.trusted)
  if (name === null) problems.push('trusted comment 沒有 file: 欄')
  else if (name !== expectedFileName) problems.push(`trusted comment 的 file: 是 ${JSON.stringify(name)}，安裝檔名是 ${JSON.stringify(expectedFileName)}`)
  return { ok: problems.length === 0, problems }
}

// 把 .sig 的 trusted comment 換成 mutate 過的版本，重新包成 base64 外殼（只動第 3 行，其餘原樣）
function rewrapSig(sigText, mutateLines) {
  const ls = lines(strictBase64(sigText).toString('utf8'))
  return Buffer.from(`${mutateLines(ls).join('\n')}\n`, 'utf8').toString('base64')
}

/**
 * 反向驗證：先確認原樣驗得過，再在記憶體裡改檔案一個位元組（必須驗不過）、改 trusted comment 一個字元（必須驗不過）。
 * 這是在驗「驗簽程式會不會擋」，不是驗檔案；原樣驗不過時回失敗，免得空轉。
 */
export function reverseVerify({ pubkeyText, sigText, fileBytes, expectedFileName }) {
  const base = verifySig({ pubkeyText, sigText, fileBytes, expectedFileName })
  if (!base.ok) return { ok: false, problems: ['原樣就驗不過，反向驗證沒有意義：', ...base.problems] }
  const pub = parsePubkey(pubkeyText)
  const sg = parseSig(sigText)
  const problems = []
  const tampered = Buffer.from(fileBytes)
  tampered[Math.floor(tampered.length / 2)] ^= 0x01
  if (verifyFileSig(pub.key, sg.sig, tampered)) problems.push('反向驗證失敗：檔案改了一個位元組，檔案簽章居然還驗得過')
  if (verifySig({ pubkeyText, sigText, fileBytes: tampered, expectedFileName }).ok) problems.push('反向驗證失敗：檔案改了一個位元組，verifySig 居然還回通過')
  const flipped = sg.trusted.slice(0, -1) + (sg.trusted.endsWith('0') ? '1' : '0')
  if (verifyGlobalSig(pub.key, sg.sig, flipped, sg.globalSig)) problems.push('反向驗證失敗：trusted comment 改了一個字元，全域簽章居然還驗得過')
  const tamperedSig = rewrapSig(sigText, ls => ls.map((l, i) => (i === 2 ? `trusted comment: ${flipped}` : l)))
  if (verifySig({ pubkeyText, sigText: tamperedSig, fileBytes, expectedFileName }).ok) problems.push('反向驗證失敗：trusted comment 改了一個字元，verifySig 居然還回通過')
  return { ok: problems.length === 0, problems }
}

/** .sig 原文要與 latest.json 該平台的 signature 欄逐字相等（只容許 .sig 檔尾端的換行；latest.json 那邊不修剪） */
export function sigMatchesLatest({ sigText, latest, platform = PLATFORM }) {
  const field = latest?.platforms?.[platform]?.signature
  if (typeof field !== 'string' || !field) return { ok: false, problems: [`latest.json 沒有 platforms.${platform}.signature`] }
  if (field !== String(sigText).replace(/[\r\n]+$/, '')) return { ok: false, problems: ['.sig 原文與 latest.json 的 signature 欄不是逐字相等'] }
  return { ok: true, problems: [] }
}

/** 一次做完：驗簽、反向驗證、（有給 latest 時）與 latest.json 逐字比對 */
// reverse 可注入，只給測試用（證明 verifyAll 真的呼叫反向驗證，且它失敗整體就失敗）
export function verifyAll({ pubkeyText, sigText, fileBytes, expectedFileName, latest, reverse = reverseVerify }) {
  const problems = []
  const a = verifySig({ pubkeyText, sigText, fileBytes, expectedFileName })
  problems.push(...a.problems)
  if (a.ok) problems.push(...reverse({ pubkeyText, sigText, fileBytes, expectedFileName }).problems)
  if (latest !== undefined) problems.push(...sigMatchesLatest({ sigText, latest }).problems)
  return { ok: problems.length === 0, problems }
}

// ---- 薄 CLI
export function main(argv = process.argv.slice(2), { readFile = p => fs.readFileSync(p), log = console.log } = {}) {
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const conf = arg('--conf'), exe = arg('--exe'), sig = arg('--sig'), latest = arg('--latest')
  if (!conf || !exe || !sig) { log('用法：--conf <tauri.conf.json> --exe <安裝檔> --sig <.sig> [--latest <latest.json>]'); return 2 }
  let r
  try {
    const pubkeyText = JSON.parse(readFile(conf).toString('utf8')).plugins.updater.pubkey
    r = verifyAll({
      pubkeyText, sigText: readFile(sig).toString('utf8'), fileBytes: readFile(exe), expectedFileName: path.basename(exe),
      latest: latest ? JSON.parse(readFile(latest).toString('utf8')) : undefined,
    })
  } catch (e) { log(`驗簽中止：${e.message}`); return 1 }
  if (!r.ok) { log(`驗簽沒過（${r.problems.length} 項）：`); for (const p of r.problems) log(`- ${p}`); return 1 }
  log(`驗簽通過（含反向驗證${latest ? '、與 latest.json 逐字相等' : ''}）：${path.basename(exe)}`)
  return 0
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main())
