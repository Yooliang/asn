// 依 agent-tools-detect 結果產生 launcher profile（指令只在本機決定，不上雲）。
import os from 'node:os'
import path from 'node:path'

/** @typedef {'window'|'background'} LaunchMode */

/**
 * @param {Record<string, { cmd: string|null }>} tools
 * @param {{ homeDir?: string, platform?: string }} opts
 */
export function buildDefaultProfiles(tools, opts = {}) {
  const platform = opts.platform ?? process.platform
  const home = opts.homeDir ?? os.homedir()
  const profiles = {}
  if (tools.claude?.cmd) profiles.claude = profileClaude(tools.claude.cmd, platform)
  if (tools.codex?.cmd) profiles.codex = profileCodex(tools.codex.cmd, platform)
  if (tools.agy?.cmd) profiles.gemini = profileGemini(tools.agy.cmd, home)
  if (tools.grok?.cmd) profiles.grok = profileGrok(tools.grok.cmd, home)
  if (tools.pi?.cmd) profiles.pi = profilePi(tools.pi.cmd, platform)
  return profiles
}

function profileClaude(cmd, platform) {
  if (platform === 'win32') {
    return {
      label: 'Claude（互動視窗）',
      mode: 'window',
      engine: 'claude',
      model: 'claude',
      command: cmd,
      args: ['--dangerously-skip-permissions', '-n', '{name}', '--remote-control', '{name}'],
    }
  }
  return {
    label: 'Claude（互動視窗）',
    mode: 'window',
    engine: 'claude',
    model: 'claude',
    command: cmd,
    args: ['--dangerously-skip-permissions', '-n', '{name}', '--remote-control', '{name}'],
  }
}

function profileCodex(cmd, platform) {
  const args = platform === 'win32'
    ? ['/c', cmd, '-c', 'check_for_update_on_startup=false', '-s', 'workspace-write', '-a', 'on-request', 'resume', '{name}']
    : ['-lc', `${shellQuote(cmd)} -c check_for_update_on_startup=false -s workspace-write -a on-request resume {name}`]
  return {
    label: 'Codex（互動視窗）',
    mode: 'window',
    engine: 'codex',
    model: 'codex',
    command: platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
    args,
  }
}

function profileGemini(cmd, home) {
  const cwd = path.join(home, '.asn', 'workers', '{name}')
  return {
    label: 'Gemini（背景運行、內建通道）',
    mode: 'background',
    engine: 'acp',
    model: 'gemini',
    acp: { protocol: 'agy-stream', command: cmd, args: [], roster_engine: 'gemini' },
    command: cmd,
    args: [],
    cwdTemplate: cwd,
  }
}

function profileGrok(cmd, home) {
  const cwd = path.join(home, '.asn', 'workers', '{name}')
  return {
    label: 'Grok（背景運行、內建通道）',
    mode: 'background',
    engine: 'acp',
    model: 'grok',
    acp: { protocol: 'acp', command: cmd, args: ['agent', 'stdio'], roster_engine: 'grok' },
    command: cmd,
    args: ['agent', 'stdio'],
    cwdTemplate: cwd,
  }
}

function profilePi(cmd, platform) {
  return {
    label: 'pi（互動視窗，實驗）',
    mode: 'window',
    engine: 'pi',
    model: 'pi',
    command: platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
    args: platform === 'win32'
      ? ['/c', 'start', 'pi', '{name}']
      : ['-lc', `${shellQuote(cmd)}`],
    disabled: true,
    disabledReason: 'pi 請從 ASN 桌面程式的「開新夥伴」開啟（要一併載入收信擴充）',
  }
}

function shellQuote(s) {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

export function defaultCwdAllow(homeDir = os.homedir()) {
  const out = new Set()
  for (const p of [
    path.join(homeDir, 'Github'),
    path.join(homeDir, 'Projects'),
    path.join(homeDir, 'projects'),
    path.join(homeDir, 'Documents'),
    path.join(homeDir, 'workspace'),
  ]) out.add(normalizePath(p))
  return [...out]
}

export function normalizePath(p) {
  return path.resolve(String(p))
}

/** UI 用：各模型的展示資訊 */
export const MODEL_CATALOG = [
  { id: 'claude', toolId: 'claude', profileId: 'claude', label: 'Claude', mode: 'window', modeLabel: '會開一個視窗', acpWhy: 'Claude 沒有內建通道，只能開成終端機視窗', channels: { term: { status: 'window', why: '開成自己的終端機視窗（不是 ASN 自帶終端），靠 asn 外掛收發信' }, acp: { status: 'no', why: '刻意不做（帳務風險，#273）' }, pi: { status: 'untested', why: 'pi 可以用 Claude 訂閱登入，ASN 裡還沒有實際用過' } } },
  { id: 'codex', toolId: 'codex', profileId: 'codex', label: 'Codex', mode: 'window', modeLabel: '會開一個視窗', acpWhy: 'Codex 還沒有內建通道，只能開成終端機視窗', channels: { term: { status: 'window', why: '開成自己的終端機視窗，還沒有真機實測' }, acp: { status: 'no', why: '還沒有內建通道' }, pi: { status: 'untested', why: 'pi 有 openai-codex 提供者，ASN 裡還沒有實際用過' } } },
  { id: 'gemini', toolId: 'agy', profileId: 'gemini', label: 'Gemini', mode: 'background', modeLabel: '由 ASN 內建通道執行', cliWhy: '終端機版可以從「＋」→「在這台開終端…」開在 ASN 自帶的終端裡，但那樣 ASN 收不到它的信；要收發信請用內建通道', channels: { term: { status: 'noinbox', why: '可以開在 ASN 自帶終端（0.1.86 起），但收不到信' }, acp: { status: 'ok', why: '背景運行，可以收發信（0.1.70 起，有真機）' }, pi: { status: 'no', why: 'pi 已拿掉 Gemini 訂閱登入，不建議' } } },
  { id: 'grok', toolId: 'grok', profileId: 'grok', label: 'Grok', mode: 'background', modeLabel: '由 ASN 內建通道執行', cliWhy: '終端機版可以從「＋」→「在這台開終端…」開在 ASN 自帶的終端裡，但那樣 ASN 收不到它的信；要收發信請用內建通道', channels: { term: { status: 'noinbox', why: '可以開在 ASN 自帶終端（0.1.84 起），但收不到信' }, acp: { status: 'ok', why: '背景運行，可以收發信（0.1.70 起，有真機）' }, pi: { status: 'untested', why: 'pi 有 xai 提供者，ASN 裡還沒有實際用過' } } },
  { id: 'pi', toolId: 'pi', profileId: 'pi', label: 'pi', mode: 'window', modeLabel: '會開一個互動視窗（只能開在前台）', foregroundOnly: true, channelOnly: true, acpWhy: 'pi 沒有內建通道，只能開成終端機視窗', channels: { term: { status: 'window', why: 'pi 自己就是互動視窗，靠 pi 擴充收發信' }, acp: { status: 'no', why: 'pi 沒有內建通道' }, pi: { status: 'ok', why: '可以切換提供者和模型' } } },
]
