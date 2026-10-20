#!/usr/bin/env node
// 一次性註冊：用邀請碼把這個雲端代理環境註冊成收發室節點，金鑰寫到 <金鑰目錄>/<代號>.key（目錄 700、檔 600、原子寫入）。
//   IRORI_INVITE=<邀請碼> node register.mjs [--id grok] [--name "Grok 雲端"] [--machine grok-cloud] [--kind grok]
//   node register.mjs --check      用已存的金鑰（或 IRORI_RELAY_KEY）呼叫 whoami，確認連得上
// 邀請碼走環境變數，不放命令列。stdout 只印一行 JSON（不含金鑰）；成功 exit 0、失敗 exit 1。金鑰絕不印出。
// 後端規則同 relay/machine/register.mjs：代號英數 - _ 1～32 字且全名單唯一、名稱 1～100 字、machine 1～40 字、同網路位址每小時 10 次、邀請碼 15 分鐘有效只能用一次。
// 為什麼不直接用 machine/register.mjs 的 registerNode：它固定寫到 ~/.irori-relay、不是原子寫入也不設目錄權限；這裡的金鑰要放在重置後保留的 /workspace。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ID_RE, readKey, resolveConfig } from './config.mjs'
import { ensureDir, writeFileAtomic } from './lib.mjs'

const KINDS = ['claude', 'gpt', 'gemini', 'grok', 'other']
const MESSAGES = {
  bad_request: '填的資料有問題（代號只能用英文、數字、-、_，最多 32 個字；machine 最多 40 個字）。',
  invalid_invite: '邀請碼不對、已經過期（15 分鐘有效）或已經用過。請再要一組新的。',
  bad_id_prefix: '這組邀請碼只能註冊指定開頭的代號。',
  id_taken: '這個代號已經有人用了。如果是這個環境以前註冊過、金鑰不見了，請管理者發「重設碼」。',
  rate_limited: '試太多次了，請一小時後再試。',
  network: '連不上伺服器。',
  unauthorized: '金鑰無效或已經作廢。',
}

async function call(baseUrl, action, { method = 'POST', key, body } = {}) {
  try {
    const res = await fetch(`${baseUrl}?action=${action}`, {
      method,
      headers: { 'content-type': 'application/json', 'user-agent': 'irori-cloud-agent/1', ...(key ? { 'x-relay-key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
    return { status: res.status, data: await res.json().catch(() => ({})) }
  } catch { return { status: 0, data: { error: 'network' } } }
}

function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (!k.startsWith('--')) continue
    const name = k.slice(2)
    if (['check', 'force'].includes(name)) a[name] = true
    else a[name] = argv[++i]
  }
  return a
}

export async function main(argv, env = process.env) {
  const a = parseArgs(argv)
  const cfg = resolveConfig(a.id ? { ...env, IRORI_RELAY_ID: a.id } : env)
  const id = cfg.node
  if (!ID_RE.test(id)) return { ok: false, error: 'bad_request', message: MESSAGES.bad_request }

  if (a.check) {
    const key = readKey(cfg, env)
    if (!key) return { ok: false, error: 'no_key', message: '找不到金鑰（沒有 IRORI_RELAY_KEY，也沒有金鑰檔）。' }
    const r = await call(cfg.baseUrl, 'whoami', { method: 'GET', key })
    if (r.status === 200 && r.data?.node) return { ok: true, node: r.data.node }
    const error = r.data?.error || 'unauthorized'
    return { ok: false, error, status: r.status, message: MESSAGES[error] ?? '檢查沒有成功。' }
  }

  const invite = String(env.IRORI_INVITE ?? '').trim()
  if (!invite) return { ok: false, error: 'bad_request', message: '沒有邀請碼：請用環境變數 IRORI_INVITE 帶入。' }
  if (fs.existsSync(cfg.keyFile) && !a.force) {
    return { ok: false, error: 'already_registered', message: `已經有金鑰檔（${cfg.keyFile}），不重複註冊；要確認連線用 --check。` }
  }
  const name = String(a.name || 'Grok 雲端').slice(0, 100)
  const machine = String(a.machine || 'grok-cloud').slice(0, 40)
  const kind = KINDS.includes(a.kind) ? a.kind : 'grok'
  const r = await call(cfg.baseUrl, 'register', { body: { invite, id, name, kind, machine, note: '雲端代理（relay/cloud-agent）' } })
  if (r.status !== 200 || typeof r.data?.key !== 'string' || !r.data.key) {
    const error = r.data?.error || (r.status === 0 ? 'network' : 'internal')
    const out = { ok: false, error, status: r.status, message: MESSAGES[error] ?? '註冊沒有成功，請稍後再試，或請管理者協助。' }
    if (error === 'bad_id_prefix' && typeof r.data?.prefix === 'string') { out.prefix = r.data.prefix; out.message = `這組邀請碼只能註冊以「${r.data.prefix}」開頭的代號。` }
    return out
  }
  ensureDir(cfg.keyDir, 0o700)
  writeFileAtomic(cfg.keyFile, r.data.key, 0o600)
  if (fs.readFileSync(cfg.keyFile, 'utf8').trim() !== r.data.key) {
    return { ok: false, error: 'write_mismatch', message: '金鑰存檔後讀回不一致，請管理者重發金鑰。' }
  }
  const check = await call(cfg.baseUrl, 'whoami', { method: 'GET', key: r.data.key })
  return { ok: true, id: r.data.id || id, verified: check.status === 200, keyFile: cfg.keyFile }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const res = await main(process.argv.slice(2))
  process.stdout.write(JSON.stringify(res) + '\n')
  process.exitCode = res.ok ? 0 : 1   // 不呼叫 process.exit：fetch 連線還在關的時候強制結束，部分平台會當掉
}
