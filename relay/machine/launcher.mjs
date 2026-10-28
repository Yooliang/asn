// 遠端開 Claude 視窗（#64，規劃見 docs/relay/LAUNCHER.md）：機器橋這一端。
// - 讀 ~/.asn/launcher.json（不進 repo）：每個 profile 的指令與參數、cwd 白名單、每小時上限
// - 摘要（profile 名與標籤、cwd 白名單、上限；不含指令）附在 roster 回報給仲介，手機的表單才有下拉選單
// - 門鈴／輪詢時 launch_pending 取走待辦 → 執行前再驗一次 → 開視窗 → 等它出現在 `claude agents` → launch_result 回報
// 指令完全由本機 launcher.json 決定；仲介來的只有 profile 名、視窗名、cwd（必須在白名單裡）。{name} 是唯一的替換欄位。
import { envGet, isSecretEnvName, withBothNames } from './env-compat.mjs'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// 跟仲介（_shared/launch.ts、07_launch.sql）同一條規則：英數、連字號、中文，1～40 字，不能以連字號開頭
export const NAME_RE = /^[A-Za-z0-9一-鿿][A-Za-z0-9一-鿿-]{0,39}$/
const DEFAULT_MAX_PER_HOUR = 6
const HOUR_MS = 3_600_000
export const TRUST_HINT = '視窗已開，但 30 秒內沒出現在名單上：可能卡在「是否信任此資料夾」，請到電腦前按一次 Enter'

/** 工作資料夾：先 path.resolve，再 realpath（符號連結、.. 都會落到實際路徑） */
export function normalizePath(p) {
  return path.resolve(String(p))
}

export function canonicalLaunchCwd(p) {
  const resolved = normalizePath(p)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function parseOneProfile(id, p) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return { error: `profile 名不合法：${id}` }
  if (!p || typeof p !== 'object') return { error: `profile ${id} 格式不對` }
  const mode = p.mode === 'background' ? 'background' : 'window'
  if (p.disabled) {
    return { profile: { label: typeof p.label === 'string' ? p.label.slice(0, 60) : id, command: '', args: [], engine: p.engine ?? '', mode, disabled: true, disabledReason: p.disabledReason ?? '' } }
  }
  if (mode === 'window') {
    if (typeof p.command !== 'string' || !p.command || !Array.isArray(p.args) || !p.args.every(a => typeof a === 'string')) {
      return { error: `profile ${id} 要有 command（字串）與 args（字串陣列）` }
    }
    if ([p.command, ...p.args].some(a => /\{(?!name\})[^}]*\}/.test(a))) return { error: `profile ${id} 只能用 {name} 這個替換欄位` }
    if (/\{name\}/.test(p.command)) return { error: `profile ${id} 的 command 不能含 {name}` }
  } else if (typeof p.command !== 'string' || !p.command) {
    return { error: `profile ${id}（背景）要有 command` }
  }
  if (p.engine != null && (typeof p.engine !== 'string' || !/^[a-z0-9_-]{1,20}$/.test(p.engine))) return { error: `profile ${id} 的 engine 要是轉接器代號（例如 claude、codex）` }
  return {
    profile: {
      label: typeof p.label === 'string' ? p.label.slice(0, 60) : id,
      command: typeof p.command === 'string' ? p.command : '',
      args: Array.isArray(p.args) ? p.args : [],
      engine: p.engine ?? (mode === 'background' ? 'acp' : ''),
      mode,
      model: typeof p.model === 'string' ? p.model : id,
      acp: p.acp && typeof p.acp === 'object' ? p.acp : null,
    },
  }
}

// 讀 launcher.json，並與 bootstrap（CLI 自動 profile）合併；手寫覆蓋同 id 的自動項。
// 0.2 H2：名單回報帶這台的平台（只回固定幾個值，其餘 null），開新夥伴精靈才寫得出對的設定說明
export function platformOf(p = process.platform) {
  return p === 'linux' ? 'linux' : p === 'win32' ? 'windows' : p === 'darwin' ? 'macos' : null
}

export const CLOSED_REASON_MAX = 120
/**
 * launcher.json 寫了 {"remote_launch": false, "reason": "…"}：這台不開放開新夥伴，原因會顯示在同帳號其他設備的精靈上。
 * 回 { closed: true, reason }（reason 只留純文字：控制字元換空白、去頭尾空白、最多 120 字，沒寫就是 null）；沒寫 remote_launch:false 回 { closed: false }
 */
export function closedFromJson(j) {
  if (!j || j.remote_launch !== false) return { closed: false }
  const r = typeof j.reason === 'string' ? j.reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim() : ''
  return { closed: true, reason: r ? [...r].slice(0, CLOSED_REASON_MAX).join('').trim() : null }
}

/** 讀 launcher.json 看這台是不是明寫不開放（讀不到、壞掉都當沒寫） */
export function readClosed(file) {
  try {
    return closedFromJson(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')))
  } catch {
    return { closed: false }
  }
}

export function loadConfig(file, bootstrap = null) {
  let j = null
  let fileErr = null
  try {
    const raw = fs.readFileSync(file, 'utf8')
    try { j = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch (e) { return { config: null, error: `launcher.json 不是合法 JSON：${e.message}` } }
  } catch (e) {
    if (e.code !== 'ENOENT') fileErr = `讀不到 ${file}：${e.message}`
  }
  // 明寫不開放：不載入任何 profile（連自動偵測的也不用），手機看到的是「不開放」與那台寫的原因
  if (closedFromJson(j).closed) return { config: null, error: 'launcher.json 寫了 remote_launch:false，這台不開放開新夥伴' }
  if (j && (j.profiles == null || typeof j.profiles !== 'object' || Array.isArray(j.profiles))) {
    return { config: null, error: 'launcher.json 缺 profiles' }
  }
  const mergedRaw = { ...(bootstrap?.profiles ?? {}), ...(j?.profiles ?? {}) }
  if (!Object.keys(mergedRaw).length) {
    if (j && Object.hasOwn(j, 'profiles')) return { config: null, error: 'launcher.json 沒有任何 profile' }
    if (!bootstrap && !j) return { config: null, ...(fileErr ? { error: fileErr } : {}) }
    return { config: null, error: fileErr || '這台電腦還沒有可用的啟動設定（請安裝 CLI 或撰寫 launcher.json）' }
  }
  const profiles = {}
  for (const [id, p] of Object.entries(mergedRaw)) {
    const one = parseOneProfile(id, p)
    if (one.error) return { config: null, error: one.error }
    profiles[id] = one.profile
  }
  const cwdAllow = (Array.isArray(j?.cwd_allow) && j.cwd_allow.length ? j.cwd_allow : bootstrap?.cwd_allow ?? [])
    .filter(c => typeof c === 'string' && c.trim()).map(c => canonicalLaunchCwd(c.trim()))
  if (!cwdAllow.length) return { config: null, error: '工作資料夾白名單 cwd_allow 是空的' }
  const max = Number.isInteger(j?.max_per_hour) ? Math.min(Math.max(j.max_per_hour, 1), 20)
    : Number.isInteger(bootstrap?.max_per_hour) ? bootstrap.max_per_hour : DEFAULT_MAX_PER_HOUR
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
  if (!config) return '這台電腦還沒有可用的啟動設定'
  if (typeof req?.name !== 'string' || !NAME_RE.test(req.name)) return '視窗名格式不對'
  if (typeof req.profile !== 'string' || !Object.hasOwn(config.profiles, req.profile)) return `沒有這個啟動設定：${req.profile}`
  const prof = config.profiles[req.profile]
  if (prof?.disabled) return prof.disabledReason || '這個模型目前無法從這裡啟動'
  if (typeof req.cwd !== 'string' || !req.cwd.trim()) return '工作資料夾不在允許清單裡'
  const cwdCanon = canonicalLaunchCwd(req.cwd)
  const allowCanon = new Set(config.cwd_allow.map(canonicalLaunchCwd))
  if (!allowCanon.has(cwdCanon)) return '工作資料夾不在允許清單裡'
  let st
  try { st = fs.statSync(cwdCanon) } catch { st = null }
  if (!st?.isDirectory()) return `工作資料夾不存在：${req.cwd}`
  req.cwd = cwdCanon
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
    if (u.startsWith('CLAUDE') || u === 'NO_COLOR' || isSecretEnvName(u)) continue
    out[k] = v
  }
  return withBothNames(out)   // 新舊名都帶，沒更新的子程式照樣讀得到（金鑰類已在上面濾掉）
}

// %VAR% 展開（只用在 command，例如 %SystemRoot%）
const expandVars = (s, env) => s.replace(/%([A-Za-z0-9_]+)%/g, (m, k) => {
  const hit = Object.keys(env).find(e => e.toUpperCase() === k.toUpperCase())
  return hit ? env[hit] : m
})

export function buildSpawn(config, req, env = process.env, envFilter = childEnv) {
  const p = config.profiles[req.profile]
  const cenv = envFilter(env, p.engine)
  // name／engine：轉接器的 openWindow 需要知道視窗名（Codex 要先替這個名字建好 thread）、橋依 engine 選轉接器；startWindow 本身不看它們
  return { command: expandVars(p.command, cenv), args: p.args.map(a => a.split('{name}').join(req.name)), cwd: req.cwd, env: cenv, name: req.name, engine: p.engine }
}

// Windows 參數引號規則（CommandLineToArgvW）：Start-Process 的 -ArgumentList 收一整串命令列，每個參數自己加引號
export function quoteArg(a) {
  if (a !== '' && !/[\s"]/.test(a)) return a
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
}

// 用 Start-Process 開一個有自己主控台視窗的行程（跟 partner-relay 的 spawn-partner.ps1 一樣）。
// 腳本是固定的；檔名、參數、資料夾都經環境變數傳進去，不拼進腳本，也就沒有引號跳脫的問題。回傳新視窗的 PID（之後只關自己記下的）
const START_PS = [
  "$f = $env:ASN_LAUNCH_FILE; $a = $env:ASN_LAUNCH_ARGS; $d = $env:ASN_LAUNCH_DIR; $w = $env:ASN_LAUNCH_STYLE",
  "Remove-Item env:ASN_LAUNCH_FILE, env:ASN_LAUNCH_ARGS, env:ASN_LAUNCH_DIR, env:ASN_LAUNCH_STYLE, env:IRORI_LAUNCH_FILE, env:IRORI_LAUNCH_ARGS, env:IRORI_LAUNCH_DIR, env:IRORI_LAUNCH_STYLE -ErrorAction SilentlyContinue",
  "if (-not $w) { $w = 'Normal' }",
  "$p = if ($a) { Start-Process -FilePath $f -ArgumentList $a -WorkingDirectory $d -WindowStyle $w -PassThru } else { Start-Process -FilePath $f -WorkingDirectory $d -WindowStyle $w -PassThru }",
  "[Console]::Out.Write($p.Id)",
].join('\n')
export function startWindowLinux({ command, args, cwd, env }) {
  const term = pickLinuxTerminal(env)
  const joined = [command, ...args].map(quoteArg).join(' ')
  if (term) {
    const argv = [...term.argsPrefix, term.binary, ...term.argsSuffix, joined]
    return spawnDetached(argv[0], argv.slice(1), cwd, env)
  }
  return spawnDetached(command, args, cwd, env)
}

function pickLinuxTerminal(env) {
  const pathEnv = env.PATH ?? ''
  const tryBins = [
    { binary: 'gnome-terminal', argsPrefix: [], argsSuffix: ['--', 'bash', '-lc'] },
    { binary: 'konsole', argsPrefix: [], argsSuffix: ['-e', 'bash', '-lc'] },
    { binary: 'xfce4-terminal', argsPrefix: [], argsSuffix: ['-e', 'bash', '-lc'] },
    { binary: 'xterm', argsPrefix: [], argsSuffix: ['-e', 'bash', '-lc'] },
  ]
  for (const t of tryBins) {
    for (const dir of pathEnv.split(':').filter(Boolean)) {
      const p = path.join(dir, t.binary)
      try { if (fs.statSync(p).isFile()) return { ...t, binary: p } } catch { /* 略過 */ }
    }
  }
  return null
}

function spawnDetached(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: 'ignore' })
    child.on('error', reject)
    child.unref()
    resolve({ pid: child.pid ?? 0 })
  })
}

export function startWindow({ command, args, cwd, env }) {
  if (process.platform !== 'win32') return startWindowLinux({ command, args, cwd, env })
  const psExe = path.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(START_PS, 'utf16le').toString('base64')
  const henvVals = { LAUNCH_FILE: command, LAUNCH_ARGS: args.map(quoteArg).join(' '), LAUNCH_DIR: cwd, LAUNCH_STYLE: envGet(process.env, 'LAUNCH_WINDOW_STYLE') || 'Normal' }
  const henv = { ...env }
  for (const [k, v] of Object.entries(henvVals)) { henv[`ASN_${k}`] = v; henv[`IRORI_${k}`] = v }
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
export function createLauncher({ api, log, workDir, configPath, listNames, onLaunched = async () => {}, start = startWindow, startBackground = null, envFilter = childEnv,
  bootstrap = null, confirmMs = 30_000, lateMs = 180_000, pollMs = 2_000 }) {
  const historyFile = path.join(workDir, 'launch-history.json')
  const logFile = path.join(workDir, 'launch.log')
  let cache = { mtime: -1, value: { config: null } }
  let warned = ''

  function current() {
    let mtime = 0
    try { mtime = fs.statSync(configPath).mtimeMs } catch { mtime = 0 }
    const bootResolved = typeof bootstrap === 'function' ? bootstrap() : bootstrap
    const bootKey = bootResolved ? JSON.stringify(bootResolved).length : 0
    const cacheKey = `${mtime}:${bootKey}`
    if (cacheKey !== cache.mtime) {
      cache = { mtime: cacheKey, value: loadConfig(configPath, bootResolved) }
      if (cache.value.error && cache.value.error !== warned) { log(`launcher: ${cache.value.error}`); warned = cache.value.error }
      if (cache.value.config?.cwd_allow) { warned = ''; log(`launcher: loaded ${Object.keys(cache.value.config.profiles).length} profile(s), ${cache.value.config.cwd_allow.length} cwd(s)`) }
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
    const prof = config.profiles[l.profile]
    let started
    if (prof.mode === 'background') {
      if (!startBackground) return report(l, 'failed', '這台機器橋尚未啟用背景夥伴啟動')
      try { started = await startBackground({ req: l, profile: prof, config }) } catch (e) { return report(l, 'failed', `背景啟動失敗：${e.message}`) }
    } else {
      const s = buildSpawn(config, l, process.env, envFilter)
      try { started = await start(s) } catch (e) { return report(l, 'failed', `開不起來：${e.message}`) }
    }
    record(l, 'spawned', `pid=${started?.pid ?? 0}`)
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
