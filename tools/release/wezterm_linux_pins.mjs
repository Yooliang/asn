// #1258 ① 發版前守門：wezterm-pins.json 的 linux 段每一包，都要真的是「本 repo 的 wezterm-build.yml 在 main 建出來的那個檔」。
// 這支只放純函式（解析 pins、比對雜湊與大小、讀 tar、檢查成員）和「I/O 由外面注入」的總驗證 verifyLinuxPins；
// 下載、gh、xz 這些真的動作在 verify_wezterm_linux_pins.mjs。規則與 Windows 的 fetch-wezterm.mjs 一致：同 repo、同 workflow、source-ref 必須是 main。
import crypto from 'node:crypto'

/** 自建包解開後必須恰好是這四個一般檔（wezterm-build-linux.sh 的打包內容），不多、不少、不是連結 */
export const EXPECTED_MEMBERS = Object.freeze(['wezterm', 'wezterm-mux-server', 'LICENSE.md', 'SOURCE.txt'])
export const SOURCE_REF = 'refs/heads/main'
const SELF_BUILT_NAME = /^wezterm-(.+)-(asn\.\d+)\.([A-Za-z]+[0-9.]+)\.tar\.xz$/
const HEX64 = /^[0-9a-f]{64}$/

/**
 * 讀 pins，整理成要驗的清單。不丟例外，回 { mode, problems, ... }：
 *   mode 'empty'     linux 段沒有任何包（一定要失敗）
 *   mode 'upstream'  全是上游版的檔名（還沒切到自建版）
 *   mode 'self-built' 全是自建版
 *   mode 'invalid'   混用、欄位不合或與 windows_bundle 對不上
 */
export function planFromPins(pins) {
  const problems = []
  const linux = pins && typeof pins.linux === 'object' && pins.linux !== null ? pins.linux : null
  const keys = linux ? Object.keys(linux) : []
  if (keys.length === 0) return { mode: 'empty', problems: ['pins 的 linux 段沒有任何一包：空清單不能當作通過'], entries: [] }
  const entries = keys.map(key => ({ key, ...linux[key] }))
  for (const e of entries) {
    if (typeof e.tarball !== 'string' || !e.tarball) problems.push(`${e.key}：缺 tarball 檔名`)
    if (!HEX64.test(String(e.sha256 ?? ''))) problems.push(`${e.key}：sha256 不是 64 位小寫十六進位`)
    if (!Number.isInteger(e.size) || e.size <= 0) problems.push(`${e.key}：size 不是正整數`)
  }
  if (problems.length) return { mode: 'invalid', problems, entries }
  const matches = entries.map(e => SELF_BUILT_NAME.exec(e.tarball))
  const selfCount = matches.filter(Boolean).length
  if (selfCount === 0) return { mode: 'upstream', problems: [], entries }
  if (selfCount !== entries.length) {
    return { mode: 'invalid', problems: ['linux 段同時有自建版與非自建版的檔名，必須整批一致'], entries }
  }
  const win = pins.windows_bundle
  if (!win || !win.repo || !win.signer_workflow) {
    return { mode: 'invalid', problems: ['pins 缺 windows_bundle 的 repo／signer_workflow，沒有可比照的建置來源規則'], entries }
  }
  const tags = new Set(matches.map(m => `wezterm-${m[1]}-${m[2]}`))
  if (tags.size !== 1) return { mode: 'invalid', problems: [`各包檔名指向不同的 release：${[...tags].join('、')}`], entries }
  const tag = [...tags][0]
  if (matches.some(m => m[1] !== pins.version)) problems.push(`檔名裡的上游版本與 pins 的 version（${pins.version}）不一致`)
  const lb = pins.linux_bundle
  if (lb) {
    if (lb.repo !== win.repo) problems.push(`linux_bundle.repo（${lb.repo}）與 windows_bundle 不同`)
    if (lb.signer_workflow !== win.signer_workflow) problems.push(`linux_bundle.signer_workflow（${lb.signer_workflow}）與 windows_bundle 不同`)
    if (lb.tag !== tag) problems.push(`linux_bundle.tag（${lb.tag}）與檔名指向的 ${tag} 不同`)
  }
  if (problems.length) return { mode: 'invalid', problems, entries }
  return { mode: 'self-built', problems: [], entries, tag, repo: win.repo, signerWorkflow: win.signer_workflow }
}

export function downloadUrl(plan, entry) {
  return `https://github.com/${plan.repo}/releases/download/${plan.tag}/${entry.tarball}`
}

export function attestationArgs(file, plan) {
  return ['attestation', 'verify', file, '--repo', plan.repo, '--signer-workflow', plan.signerWorkflow, '--source-ref', SOURCE_REF]
}

export const sha256Hex = buf => crypto.createHash('sha256').update(buf).digest('hex')

/** 大小與雜湊：回傳問題清單（空＝通過）。先比大小，不符就不必算雜湊 */
export function bytesProblems(buf, entry) {
  if (buf.length !== entry.size) return [`大小不符：pins 寫 ${entry.size}，實際 ${buf.length}`]
  const got = sha256Hex(buf)
  return got === entry.sha256 ? [] : [`雜湊不符：pins 寫 ${entry.sha256}，實際 ${got}`]
}

const TYPE_NAME = { '1': '硬連結', '2': '符號連結', '3': '字元裝置', '4': '區塊裝置', '5': '資料夾', '6': 'FIFO', x: '擴充標頭', g: '全域擴充標頭', L: 'GNU 長檔名', K: 'GNU 長連結名' }

const cstr = b => { const i = b.indexOf(0); return b.subarray(0, i < 0 ? b.length : i).toString('utf8') }

/** 讀未壓縮的 tar（ustar／GNU 標頭），回 { entries: [{name, type, size}], error }；type 是標頭的 typeflag（'0'＝一般檔） */
export function parseTar(buf) {
  const entries = []
  let off = 0
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512)
    if (h.every(x => x === 0)) return { entries, error: null }
    const stored = parseInt(cstr(h.subarray(148, 156)).trim() || '0', 8)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]
    if (stored !== sum) return { entries, error: `tar 標頭檢查碼不符（位置 ${off}）` }
    const sizeField = h.subarray(124, 136)
    if (sizeField[0] & 0x80) return { entries, error: `tar 檔案大小用了不支援的編碼（位置 ${off}）` }
    const size = parseInt(cstr(sizeField).trim() || '0', 8)
    if (!Number.isFinite(size) || size < 0) return { entries, error: `tar 檔案大小讀不懂（位置 ${off}）` }
    const prefix = cstr(h.subarray(345, 500))
    const name = (prefix ? `${prefix}/` : '') + cstr(h.subarray(0, 100))
    const flag = String.fromCharCode(h[156] || 48)   // 空位元組等同 '0'
    entries.push({ name, type: flag === '\0' ? '0' : flag, size })
    const dataBlocks = Math.ceil(size / 512)   // 連結與資料夾的 size 為 0；擴充標頭、長檔名帶資料，一樣照 size 跳過
    off += 512 + dataBlocks * 512
    if (off > buf.length) return { entries, error: 'tar 內容被截斷' }
  }
  return { entries, error: 'tar 沒有正常結尾' }
}

/** 成員檢查：必須恰好是 EXPECTED_MEMBERS 四個一般檔。回傳問題清單 */
export function memberProblems(entries, expected = EXPECTED_MEMBERS) {
  const problems = []
  const seen = new Map()
  for (const e of entries) seen.set(e.name, (seen.get(e.name) ?? 0) + 1)
  for (const e of entries) {
    if (e.type !== '0') problems.push(`成員「${e.name}」不是一般檔（${TYPE_NAME[e.type] ?? `型別 ${e.type}`}）`)
    if (e.name.startsWith('/') || e.name.split('/').includes('..') || /^[A-Za-z]:/.test(e.name)) problems.push(`成員「${e.name}」的路徑會跑出解壓資料夾`)
    if (!expected.includes(e.name)) problems.push(`多出不該有的成員「${e.name}」`)
  }
  for (const [name, n] of seen) if (n > 1) problems.push(`成員「${name}」重複出現 ${n} 次`)
  for (const want of expected) if (!seen.has(want)) problems.push(`缺少成員「${want}」`)
  return problems
}

/**
 * 總驗證。io 由外面注入：
 *   io.getFile(entry)       -> Buffer（下載或讀已下載的檔）
 *   io.fileOnDisk(entry)    -> 檔案路徑（給 gh 驗證用）
 *   io.attest(file, plan)   -> { ok, detail }（gh attestation verify 的結果）
 *   io.tarMembers(buf)      -> { entries, error }（解 xz 後讀 tar）
 * 回傳 { results: [{key, tarball, problems}], ok }。每一包的每一項都跑，不在第一個錯誤就停，方便一次看全。
 */
export async function verifyLinuxPins(plan, io) {
  const results = []
  for (const entry of plan.entries) {
    const problems = []
    const add = (item, msg) => problems.push(`${item}：${msg}`)
    let buf = null
    try { buf = await io.getFile(entry) } catch (e) { add('取得檔案', String(e.message || e)) }
    if (buf) {
      problems.push(...bytesProblems(buf, entry))
      try {
        const a = await io.attest(await io.fileOnDisk(entry), plan)
        if (!a.ok) add('建置來源證明', a.detail || '驗不過')
      } catch (e) { add('建置來源證明', String(e.message || e)) }
      try {
        const t = await io.tarMembers(buf)
        if (t.error) add('成員清單', t.error)
        for (const p of memberProblems(t.entries)) add('成員清單', p)
      } catch (e) { add('成員清單', String(e.message || e)) }
    }
    results.push({ key: entry.key, tarball: entry.tarball, problems })
  }
  return { results, ok: results.length > 0 && results.every(r => r.problems.length === 0) }
}
