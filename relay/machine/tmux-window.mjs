// 0.2 H4（#431）：沒有桌面的 Linux 用 tmux 開夥伴的視窗（claude、codex）。
// 以前找不到圖形終端時，會把指令直接丟到背景跑（沒有 TTY），互動式 CLI 不是馬上結束就是卡住、也沒有說明；現在改成：
//   有桌面（DISPLAY／WAYLAND_DISPLAY）且找得到圖形終端 → 照舊開終端；否則有 tmux 3.2 以上 → 開一個 tmux session；都沒有 → 直接失敗並說明。
// tmux 3.2 以上才有 new-session -e，而且多個參數會直接 exec、不經 shell；舊版會把參數接成一個字串交給 sh（特殊字元會被 shell 解讀），
// 所以版本太舊就直接拒絕，不退回字串拼接。session 名是 asn-<名字>，用 has-session -t =asn-<名字> 精確比對（= 避免前綴比到別的 session）。
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const TMUX_MIN = [3, 2]
export const NO_TMUX = '這台沒有桌面也沒有 tmux，請先安裝 tmux（例如 sudo apt install tmux）再試'
export const TMUX_OLD = 'tmux 版本太舊（需要 3.2 以上），請更新 tmux 再試'
export const sessionName = name => `asn-${name}`
export const attachHint = name => `在那台執行 tmux attach -t ${sessionName(name)} 可以看到這個視窗`

export const hasDesktop = env => Boolean(env?.DISPLAY || env?.WAYLAND_DISPLAY)

/** `tmux -V` 的輸出（「tmux 3.2a」「tmux next-3.4」「tmux 3.3」）→ [主, 次]；看不懂回 null */
export function parseTmuxVersion(out) {
  const m = /(\d+)\.(\d+)/.exec(String(out ?? ''))
  return m ? [Number(m[1]), Number(m[2])] : null
}
export const versionOk = v => Boolean(v) && (v[0] > TMUX_MIN[0] || (v[0] === TMUX_MIN[0] && v[1] >= TMUX_MIN[1]))

/** 在 PATH 裡找執行檔（找不到回 null） */
export function findBin(bin, pathEnv = '') {
  for (const dir of String(pathEnv).split(':').filter(Boolean)) {
    const p = path.join(dir, bin)
    try { if (fs.statSync(p).isFile()) return p } catch { /* 略過 */ }
  }
  return null
}

/** 跑一次 tmux（argv 直接傳，不經 shell）：回 { code, stdout } */
export function runTmux(tmux, args, env) {
  return new Promise(resolve => {
    execFile(tmux, args, { env, timeout: 15_000 }, (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? '') }))
  })
}

/**
 * 用 tmux 開一個 session 跑 command／args（在 cwd，帶 env）。回 { pid（pane 裡那個程式的 pid）, tmux: session 名 }。
 * deps.run 可換成假的（測試用）
 */
export async function startTmuxWindow({ command, args, cwd, env, name }, { tmux, run = runTmux } = {}) {
  if (!tmux) throw new Error(NO_TMUX)
  if (!name) throw new Error('用 tmux 開視窗需要視窗名字')
  const ver = await run(tmux, ['-V'], env)
  if (ver.code !== 0 || !versionOk(parseTmuxVersion(ver.stdout))) throw new Error(TMUX_OLD)
  const s = sessionName(name)
  if ((await run(tmux, ['has-session', '-t', `=${s}`], env)).code === 0) throw new Error(`已經有叫「${s}」的 tmux session，換個名字或先關掉它`)
  // 環境變數一個一個用 -e 帶（tmux server 已經在跑時，新 session 不會繼承這個 client 的環境）；env 已經是 childEnv 濾過、沒有金鑰的
  const envFlags = Object.entries(env ?? {}).filter(([k, v]) => k && !k.includes('=') && v != null).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  const made = await run(tmux, ['new-session', '-d', '-s', s, '-c', cwd, ...envFlags, command, ...args], env)
  if (made.code !== 0) throw new Error(`tmux 開不起來（結束碼 ${made.code}）`)
  const shown = await run(tmux, ['display-message', '-p', '-t', `=${s}`, '#{pane_pid}'], env)
  return { pid: Number(String(shown.stdout).trim()) || 0, tmux: s }
}
