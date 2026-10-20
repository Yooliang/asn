// 合併手寫 launcher.json 與 CLI 自動產生的 profile。
import fs from 'node:fs'
import path from 'node:path'
import { detectAgentTools } from './agent-tools-detect.mjs'
import { buildDefaultProfiles, defaultCwdAllow, normalizePath } from './launcher-profiles.mjs'

const DEFAULT_MAX = 6

/**
 * @param {string} file launcher.json 路徑
 * @param {{ detect?: () => Promise<Record<string, unknown>>, homeDir?: string, platform?: string }} deps
 */
export async function resolveLauncherConfig(file, deps = {}) {
  const home = deps.homeDir ?? undefined
  let manual = null
  let manualError = null
  try {
    const raw = fs.readFileSync(file, 'utf8')
    manual = parseManualJson(raw, file)
  } catch (e) {
    if (e.code !== 'ENOENT') manualError = e.message
  }
  const tools = deps.detect ? await deps.detect() : await detectAgentTools({ platform: deps.platform })
  const autoProfiles = buildDefaultProfiles(tools, { homeDir: home, platform: deps.platform })
  const mergedProfiles = { ...autoProfiles, ...(manual?.profiles ?? {}) }
  const cwdAllow = manual?.cwd_allow?.length ? manual.cwd_allow : defaultCwdAllow(home)
  const maxPerHour = manual?.max_per_hour ?? DEFAULT_MAX
  if (!Object.keys(mergedProfiles).length) {
    return { config: null, error: manualError || '找不到任何可用的啟動設定（請安裝 Claude、Codex 或其他 CLI）', tools }
  }
  if (!cwdAllow.length) return { config: null, error: '工作資料夾白名單是空的', tools }
  const profiles = {}
  for (const [id, p] of Object.entries(mergedProfiles)) {
    const norm = normalizeProfile(id, p)
    if (norm.error) return { config: null, error: norm.error, tools }
    profiles[id] = norm.profile
  }
  return {
    config: { profiles, cwd_allow: cwdAllow.map(normalizePath), max_per_hour: maxPerHour },
    tools,
    sources: { manual: Boolean(manual), auto: Object.keys(autoProfiles) },
  }
}

function parseManualJson(raw, file) {
  let j
  try { j = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch (e) { throw new Error(`launcher.json 不是合法 JSON：${e.message}`) }
  if (!j?.profiles || typeof j.profiles !== 'object') throw new Error('launcher.json 缺 profiles')
  const profiles = {}
  for (const [id, p] of Object.entries(j.profiles)) {
    profiles[id] = { ...p, mode: p.mode ?? (p.engine === 'acp' ? 'background' : 'window') }
  }
  const cwd_allow = Array.isArray(j.cwd_allow) ? j.cwd_allow.filter(c => typeof c === 'string' && c.trim()).map(c => normalizePath(c.trim())) : []
  const max_per_hour = Number.isInteger(j.max_per_hour) ? Math.min(Math.max(j.max_per_hour, 1), 20) : DEFAULT_MAX
  return { profiles, cwd_allow, max_per_hour }
}

function normalizeProfile(id, p) {
  if (!p || typeof p !== 'object') return { error: `profile ${id} 格式不對` }
  if (p.disabled) {
    return {
      profile: {
        label: typeof p.label === 'string' ? p.label.slice(0, 60) : id,
        command: p.command ?? '',
        args: Array.isArray(p.args) ? p.args : [],
        engine: p.engine ?? '',
        mode: p.mode ?? 'window',
        model: p.model ?? id,
        disabled: true,
        disabledReason: typeof p.disabledReason === 'string' ? p.disabledReason : '尚未提供',
        acp: p.acp ?? null,
      },
    }
  }
  const mode = p.mode === 'background' ? 'background' : 'window'
  if (mode === 'window') {
    if (typeof p.command !== 'string' || !p.command || !Array.isArray(p.args)) {
      return { error: `profile ${id} 要有 command 與 args` }
    }
    if ([p.command, ...p.args].some(a => /\{(?!name\})[^}]*\}/.test(a))) return { error: `profile ${id} 只能用 {name} 替換` }
    if (/\{name\}/.test(p.command)) return { error: `profile ${id} 的 command 不能含 {name}` }
  }
  return {
    profile: {
      label: typeof p.label === 'string' ? p.label.slice(0, 60) : id,
      command: typeof p.command === 'string' ? p.command : '',
      args: Array.isArray(p.args) ? p.args.map(String) : [],
      engine: typeof p.engine === 'string' ? p.engine : (mode === 'background' ? 'acp' : ''),
      mode,
      model: typeof p.model === 'string' ? p.model : id,
      acp: p.acp && typeof p.acp === 'object' ? p.acp : null,
      cwdTemplate: typeof p.cwdTemplate === 'string' ? p.cwdTemplate : null,
    },
  }
}

/** 同步版：給 launcher.mjs 快取用（detect 結果需外部傳入） */
export function mergeConfigFromParsed(manualParse, autoProfiles, cwdAllow, maxPerHour) {
  const profiles = { ...autoProfiles, ...(manualParse?.profiles ?? {}) }
  return {
    profiles: Object.fromEntries(Object.entries(profiles).map(([id, p]) => {
      const n = normalizeProfile(id, p)
      return n.error ? [id, null] : [id, n.profile]
    }).filter(([, v]) => v)),
    cwd_allow: cwdAllow,
    max_per_hour: maxPerHour,
  }
}
