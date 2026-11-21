// #1258 ① 發版前守門：驗 wezterm-pins.json 的 Linux 自建包（大小、SHA-256、建置來源證明、解開後的成員）。只在發版機或 CI 跑，要有 gh 與 xz。
// 用法：node tools/release/verify_wezterm_linux_pins.mjs [--pins <pins.json>] [--dl-dir <資料夾>] [--expect-self-built]
//   --pins              指定 pins 檔（預設 relay/asn/scripts/wezterm-pins.json）；切換前可拿「填了候選值的副本」先驗
//   --dl-dir            下載與暫存的資料夾；裡面已有同名檔就直接用（不重抓），沒有就下載進去（預設用系統暫存夾裡新建的資料夾）
//   --expect-self-built pins 的 linux 段必須是自建版；還是上游版就失敗（切換之後的發版流程要帶這個）
// 結束碼：0＝全部通過，或 linux 仍是上游版（會明確印出「略過」）；1＝有任何一項不符、清單是空的、或參數不對。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { planFromPins, verifyLinuxPins, parseTar, downloadUrl, attestationArgs } from './wezterm_linux_pins.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PINS = path.join(HERE, '..', '..', 'relay', 'asn', 'scripts', 'wezterm-pins.json')
const MAX_DECOMPRESSED = 256 * 1024 * 1024

export function parseArgs(argv) {
  const o = { pins: DEFAULT_PINS, dlDir: null, expectSelfBuilt: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--expect-self-built') o.expectSelfBuilt = true
    else if (a === '--pins' || a === '--dl-dir') {
      if (!argv[i + 1]) throw new Error(`${a} 後面要接路徑`)
      o[a === '--pins' ? 'pins' : 'dlDir'] = argv[++i]
    } else throw new Error(`不認得的參數：${a}`)
  }
  return o
}

function fileNameOk(name) { return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..') }

async function download(url, size, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下載失敗（HTTP ${res.status}）：${url}`)
  const len = Number(res.headers.get('content-length'))
  if (Number.isFinite(len) && len > 0 && len !== size) throw new Error(`下載的檔案宣告大小 ${len}，與 pins 的 ${size} 不符，不下載`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(dest, buf)
  return buf
}

export function realIo(plan, dlDir, runGh = spawnSync, runXz = spawnSync) {
  const pathOf = e => path.join(dlDir, e.tarball)
  return {
    async getFile(e) {
      if (!fileNameOk(e.tarball)) throw new Error(`檔名不合法：${e.tarball}`)
      const p = pathOf(e)
      if (fs.existsSync(p)) return fs.readFileSync(p)
      console.log(`  下載 ${downloadUrl(plan, e)}`)
      return download(downloadUrl(plan, e), e.size, p)
    },
    fileOnDisk: e => pathOf(e),
    attest(file) {
      const r = runGh('gh', attestationArgs(file, plan), { encoding: 'utf8' })
      if (r.error) return { ok: false, detail: `找不到 gh CLI（${r.error.message}）` }
      return r.status === 0 ? { ok: true } : { ok: false, detail: (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ') || `gh 結束碼 ${r.status}` }
    },
    tarMembers(buf) {
      const r = runXz('xz', ['-dc'], { input: buf, maxBuffer: MAX_DECOMPRESSED })
      if (r.error) throw new Error(`解開 xz 失敗（需要 xz 指令）：${r.error.message}`)
      if (r.status !== 0) return { entries: [], error: `xz 解壓失敗：${String(r.stderr || '').trim()}` }
      return parseTar(r.stdout)
    },
  }
}

/** 主流程，回結束碼；log 與 io 可注入 */
export async function main(argv, { log = console.log, errLog = console.error, makeIo = realIo } = {}) {
  let opts
  try { opts = parseArgs(argv) } catch (e) { errLog(String(e.message)); return 1 }
  let pins
  try { pins = JSON.parse(fs.readFileSync(opts.pins, 'utf8')) } catch (e) { errLog(`讀不到或讀不懂 pins：${opts.pins}（${e.message}）`); return 1 }
  const plan = planFromPins(pins)
  if (plan.mode === 'empty' || plan.mode === 'invalid') {
    errLog('Linux pins 不合格：'); for (const p of plan.problems) errLog(`  - ${p}`); return 1
  }
  if (plan.mode === 'upstream') {
    if (opts.expectSelfBuilt) { errLog('Linux pins 仍指向上游版，但這次要求必須是自建版（--expect-self-built）：失敗'); return 1 }
    log('Linux 仍為上游版，略過自建驗證（沒有驗任何東西；切到自建版後這支才會真的檢查）')
    return 0
  }
  const dlDir = opts.dlDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wezterm-linux-pins-'))
  fs.mkdirSync(dlDir, { recursive: true })
  log(`驗證 ${plan.entries.length} 包（${plan.tag}，${plan.repo}）`)
  const { results, ok } = await verifyLinuxPins(plan, makeIo(plan, dlDir))
  for (const r of results) {
    if (r.problems.length === 0) log(`  通過  ${r.key}  ${r.tarball}（大小、雜湊、建置來源證明、成員）`)
    else { errLog(`  不符  ${r.key}  ${r.tarball}`); for (const p of r.problems) errLog(`        - ${p}`) }
  }
  log(ok ? `全部 ${results.length} 包通過` : '有包沒通過：不可把這些雜湊寫進 pins 或發版')
  return ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(c => process.exit(c), e => { console.error(String(e.stack || e)); process.exit(1) })
}
