// 遠端開 Claude 視窗（#64，規劃見 docs/relay/LAUNCHER.md）：機器橋這一端。
// - 讀 ~/.irori-relay/launcher.json（不進 repo）：每個 profile 的指令與參數、cwd 白名單、每小時上限
// - 摘要（profile 名與標籤、cwd 白名單、上限；不含指令）附在 roster 回報給仲介，手機的表單才有下拉選單
// - 門鈴／輪詢時 launch_pending 取走待辦 → 執行前再驗一次 → 開視窗 → 等它出現在 `claude agents` → launch_result 回報
// 指令完全由本機 launcher.json 決定；仲介來的只有 profile 名、視窗名、cwd（必須在白名單裡）。{name} 是唯一的替換欄位。
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// 跟仲介（_shared/launch.ts、07_launch.sql）同一條規則：英數、連字號、中文，1～40 字，不能以連字號開頭
export const NAME_RE = /^[A-Za-z0-9一-鿿][A-Za-z0-9一-鿿-]{0,39}$/
const DEFAULT_MAX_PER_HOUR = 6
const HOUR_MS = 3_600_000
export const TRUST_HINT = '視窗已開，但 30 秒內沒出現在名單上：可能卡在「是否信任此資料夾」，請到電腦前按一次 Enter'

// 讀並檢查 launcher.json；不存在回 {config:null}，格式錯回 {config:null, error}
export function loadConfig(file) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) { return e.code === 'ENOENT' ? { config: null } : { config: null, error: `讀不到 ${file}：${e.message}` } }
  let j
  try { j = JSON.parse(raw.replace(/^﻿/, '')) } catch (e) { return { config: null, error: `launcher.json 不是合法 JSON：${e.message}` } }
  if (!j || typeof j !== 'object' || !j.profiles || typeof j.profiles !== 'object' || Array.isArray(j.profiles)) return { config: null, error: 'launcher.json 缺 profiles' }
  const profiles = {}
  for (const [id, p] of Object.entries(j.profiles)) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return { config: null, error: `profile 名不合法：${id}` }
    if (!p || typeof p.command !== 'string' || !p.command || !Array.isArray(p.args) || !p.args.every(a => typeof a === 'string')) {
      return { config: null, error: `profile ${id} 要有 command（字串）與 args（字串陣列）` }
    }
    // {name} 以外的 {…} 一律不准（避免以為可以替換 cwd 之類的東西）
    if ([p.command, ...p.args].some(a => /\{(?!name\})[^}]*\}/.test(a))) return { config: null, error: `profile ${id} 只能用 {name} 這個替換欄位` }
    if (/\{name\}/.test(p.command)) return { config: null, error: `profile ${id} 的 command 不能含 {name}` }
    profiles[id] = { label: typeof p.label === 'string' ? p.label.slice(0, 60) : id, command: p.command, args: p.args }
  }
  if (!Object.keys(profiles).length) return { config: null, error: 'launcher.json 沒有任何 profile' }
  const cwdAllow = Array.isArray(j.cwd_allow) ? j.cwd_allow.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim()) : []
  if (!cwdAllow.length) return { config: null, error: 'launcher.json 的 cwd_allow 是空的' }
  const max = Number.isInteger(j.max_per_hour) ? Math.min(Math.max(j.max_per_hour, 1), 20) : DEFAULT_MAX_PER_HOUR
  return { config: { profiles, cwd_allow: cwdAllow, max_per_hour: max } }
}

// 給仲介的摘要：不含指令內容
export function summary(config) {
  if (!config) return null
  return {
    profiles: Object.entries(config.profiles).map(([id, p]) => ({ id, label: p.label })),
    cwd_allow: config.cwd_allow,
    max_per_hour: config.max_per_hour,
  }
}

// 執行前再驗一次；通過回 null，不通過回原因（中文，會回報給手機）
export function check(config, req, { names = new Set(), recent = [], now = Date.now() } = {}) {
  if (!config) return '這台電腦沒有 launcher.json'
  if (typeof req?.name !== 'string' || !NAME_RE.test(req.name)) return '視窗名格式不對'
  if (typeof req.profile !== 'string' || !Object.hasOwn(config.profiles, req.profile)) return `沒有這個啟動設定：${req.profile}`
  if (typeof req.cwd !== 'string' || !config.cwd_allow.includes(req.cwd)) return '工作資料夾不在允許清單裡'
  let st
  try { st = fs.statSync(req.cwd) } catch { st = null }
  if (!st?.isDirectory()) return `工作資料夾不存在：${req.cwd}`
  const lower = req.name.toLowerCase()
  if ([...names].some(n => String(n).toLowerCase() === lower)) return `已經有叫「${req.name}」的視窗`
  if (recent.filter(t => now - t < HOUR_MS).length >= config.max_per_hour) return `這個小時已經開了 ${config.max_per_hour} 個視窗，超過上限`
  return null
}

// 子行程的環境：清掉繼承來的 CLAUDE_*（不然新視窗會被當成橋的子行程）、NO_COLOR、仲介金鑰
export function childEnv(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    const u = k.toUpperCase()
    if (u.startsWith('CLAUDE') || u === 'NO_COLOR' || u === 'IRORI_RELAY_KEY' || u === 'IRORI_RELAY_ANON_KEY') continue
    out[k] = v
  }
  return out
}

// %VAR% 展開（只用在 command，例如 %SystemRoot%）
const expandVars = (s, env) => s.replace(/%([A-Za-z0-9_]+)%/g, (m, k) => {
  const hit = Object.keys(env).find(e => e.toUpperCase() === k.toUpperCase())
  return hit ? env[hit] : m
})

export function buildSpawn(config, req, env = process.env) {
  const p = config.profiles[req.profile]
  const cenv = childEnv(env)
  return { command: expandVars(p.command, cenv), args: p.args.map(a => a.split('{name}').join(req.name)), cwd: req.cwd, env: cenv }
}

// Windows 參數引號規則（CommandLineToArgvW）：Start-Process 的 -ArgumentList 收一整串命令列，每個參數自己加引號
export function quoteArg(a) {
  if (a !== '' && !/[\s"]/.test(a)) return a
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
}

// 用 Start-Process 開一個有自己主控台視窗的行程（跟 partner-relay 的 spawn-partner.ps1 一樣）。
// 腳本是固定的；檔名、參數、資料夾都經環境變數傳進去，不拼進腳本，也就沒有引號跳脫的問題。回傳新視窗的 PID（之後只關自己記下的）
const START_PS = [
  "$f = $env:IRORI_LAUNCH_FILE; $a = $env:IRORI_LAUNCH_ARGS; $d = $env:IRORI_LAUNCH_DIR; $w = $env:IRORI_LAUNCH_STYLE",
  "Remove-Item env:IRORI_LAUNCH_FILE, env:IRORI_LAUNCH_ARGS, env:IRORI_LAUNCH_DIR, env:IRORI_LAUNCH_STYLE",
  "if (-not $w) { $w = 'Normal' }",
  "$p = if ($a) { Start-Process -FilePath $f -ArgumentList $a -WorkingDirectory $d -WindowStyle $w -PassThru } else { Start-Process -FilePath $f -WorkingDirectory $d -WindowStyle $w -PassThru }",
  "[Console]::Out.Write($p.Id)",
].join('\n')
export function startWindow({ command, args, cwd, env }) {
  const psExe = path.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(START_PS, 'utf16le').toString('base64')
  const henv = { ...env, IRORI_LAUNCH_FILE: command, IRORI_LAUNCH_ARGS: args.map(quoteArg).join(' '), IRORI_LAUNCH_DIR: cwd,
    IRORI_LAUNCH_STYLE: process.env.IRORI_LAUNCH_WINDOW_STYLE || 'Normal' }
  return new Promise((resolve, reject) => {
    execFile(psExe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env: henv, cwd, windowsHide: true, timeout: 30_000 }, (err, out, errOut) => {
        if (err) return reject(new Error(String(errOut || err.message).trim().split(/\r?\n/)[0]))
        const pid = Number(String(out).trim())
        if (!pid) return reject(new Error('Start-Process 沒有回傳 PID'))
        resolve({ pid })
      })
  })
}

// deps：api(action, opts)、log(msg)、workDir、configPath、listNames() → Promise<Set|null>（本機目前的 session 名）、
//       onLaunched(launch) 視窗出現後呼叫（橋拿來刷新名單、送第一句話）、start（開視窗，測試可換掉）
export function createLauncher({ api, log, workDir, configPath, listNames, onLaunched = async () => {}, start = startWindow,
  confirmMs = 30_000, lateMs = 180_000, pollMs = 2_000 }) {
  const historyFile = path.join(workDir, 'launch-history.json')
  const logFile = path.join(workDir, 'launch.log')
  let cache = { mtime: -1, value: { config: null } }
  let warned = ''

  function current() {
    let mtime = 0
    try { mtime = fs.statSync(configPath).mtimeMs } catch { mtime = 0 }
    if (mtime !== cache.mtime) {
      cache = { mtime, value: loadConfig(configPath) }
      if (cache.value.error && cache.value.error !== warned) { log(`launcher: ${cache.value.error}`); warned = cache.value.error }
      if (cache.value.config) { warned = ''; log(`launcher: loaded ${Object.keys(cache.value.config.profiles).length} profile(s), ${cache.value.config.cwd_allow.length} cwd(s)`) }
    }
    return cache.value.config
  }
  const readHistory = () => { try { return JSON.parse(fs.readFileSync(historyFile, 'utf8')).filter(Number.isFinite) } catch { return [] } }
  const writeHistory = h => { try { fs.writeFileSync(historyFile, JSON.stringify(h.filter(t => Date.now() - t < HOUR_MS))) } catch {} }
  const record = (l, status, detail) => {
    const line = JSON.stringify({ at: new Date().toISOString(), id: l.id, by: l.requested_by, profile: l.profile, name: l.name, cwd: l.cwd, status, detail })
    try { fs.appendFileSync(logFile, line + '\n') } catch {}
    log(`launch ${l.id} name=${l.name} profile=${l.profile} -> ${status}${detail ? ` (${detail})` : ''}`)
  }
  async function report(l, status, detail) {
    record(l, status, detail)
    try { await api('launch_result', { method: 'POST', body: { id: l.id, status, detail } }) } catch (e) { log(`launch_result failed id=${l.id}: ${e.message}`) }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const seenIds = new Set()

  async function handle(l) {
    if (seenIds.has(l.id)) return
    seenIds.add(l.id)
    const config = current()
    const names = await listNames()
    if (!names) return report(l, 'failed', '讀不到本機的 session 清單（claude agents 失敗）')
    const recent = readHistory()
    const why = check(config, l, { names, recent })
    if (why) return report(l, 'failed', why)
    writeHistory([...recent, Date.now()])
    const s = buildSpawn(config, l)
    let started
    try { started = await start(s) } catch (e) { return report(l, 'failed', `開不起來：${e.message}`) }
    record(l, 'spawned', `pid=${started.pid}`)
    const t0 = Date.now()
    let unconfirmed = false
    while (Date.now() - t0 < lateMs) {
      await sleep(pollMs)
      const now = await listNames()
      if (now && [...now].some(n => n === l.name)) {
        await report(l, 'ok', `${l.name} 已開啟`)
        try { await onLaunched(l) } catch (e) { log(`launch onLaunched failed id=${l.id}: ${e.message}`) }
        return
      }
      if (!unconfirmed && Date.now() - t0 >= confirmMs) { unconfirmed = true; await report(l, 'unconfirmed', TRUST_HINT) }
    }
    record(l, 'gave-up', `${Math.round(lateMs / 60000)} 分鐘內都沒出現在名單上`)
  }

  let pulling = false, again = false
  async function pull() {
    if (pulling) { again = true; return }
    pulling = true
    try {
      do {
        again = false
        const { launches = [] } = await api('launch_pending')
        for (const l of launches) void handle(l).catch(e => log(`launch handle failed id=${l.id}: ${e.stack ?? e}`))
      } while (again)
    } catch (e) { if (e.status !== 404) log(`launch_pending failed: ${e.message}`) } finally { pulling = false }
  }

  return { pull, summary: () => summary(current()), current }
}
