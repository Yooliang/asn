// Codex 轉接器的「找到 codex 執行檔」與「子行程環境」。
// - Windows 的 npm 安裝只有 codex.cmd 外殼；Node 20.12 起不經 shell 不能直接 spawn .cmd，
//   所以改成「node + 套件裡的 bin/codex.js」（codex.ps1／codex.cmd 做的事就是這個），不需要 shell、沒有引號問題。
// - 測試用：ASN_CODEX_SCRIPT 指向一支 node 腳本時，用 node 跑它來取代 codex（test/fake-codex.mjs）。
import { envGet, SECRET_NAMES, withBothNames } from '../env-compat.mjs'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export function resolveCodex(env = process.env) {
  if (envGet(env, 'CODEX_SCRIPT')) return { command: process.execPath, pre: [envGet(env, 'CODEX_SCRIPT')] }
  if (envGet(env, 'CODEX_BIN')) return { command: envGet(env, 'CODEX_BIN'), pre: [] }
  if (process.platform === 'win32') {
    for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
      if (!fs.existsSync(path.join(dir, 'codex.cmd'))) continue
      const js = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      if (fs.existsSync(js)) return { command: process.execPath, pre: [js] }
    }
  }
  return { command: 'codex', pre: [] }
}

// 給 codex 子行程的環境（reader app-server、codex queue、新開的視窗共用）：
// - 清掉 OPENAI_API_KEY／CODEX_API_KEY：帳務要走使用者自己的 ChatGPT 登入額度，不要意外變成用 API 金鑰計費
// - 清掉繼承來的 CODEX_THREAD_ID 等視窗識別（不然新視窗會被當成別的視窗）、NO_COLOR、CLAUDE*、仲介金鑰
// 保留 CODEX_HOME（使用者的 codex 資料夾位置）
const DROP_EXACT = new Set(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'NO_COLOR', ...SECRET_NAMES])
export function codexChildEnv(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    const u = k.toUpperCase()
    if (DROP_EXACT.has(u) || u.startsWith('CLAUDE') || u.startsWith('CODEX_SANDBOX') || u.startsWith('CODEX_MANAGED')) continue
    out[k] = v
  }
  return withBothNames(out)   // 新舊名都帶
}

// 執行一個 codex 子命令（codex queue、--version 之類的短命令）。stdin 一律關掉：codex exec 之類在 stdin 沒關時會卡住等輸入。
export function runCodex(codex, args, { env, cwd, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(codex.command, [...codex.pre, ...args],
      { env, cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 << 20, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) { const e = new Error((String(stderr || err.message).trim().split(/\r?\n/).find(l => l.trim()) || err.message).replace(/^Error:\s*/, '')); e.code = err.code; return reject(e) }
        resolve({ stdout: String(stdout), stderr: String(stderr) })
      })
    child.stdin?.end()
  })
}

// "codex-cli 0.154.0" → { major, minor, patch, text }；認不出就回 null
export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''))
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], text: m[0] } : null
}
