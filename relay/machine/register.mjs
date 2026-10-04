// 用邀請碼把這台電腦註冊成 Relay 的機器節點（給 Windows 安裝程式 install.ps1 用，也可單獨用）。
// 規則照後端 register（supabase/functions/irori-relay、sql/16_tenants.sql）：
//   id：英數、-、_，1～32 字，全名單唯一（撞名回 409 id_taken）；邀請碼若限定前綴（工頭開的），id 必須以前綴開頭（403 bad_id_prefix，邀請碼不會被用掉）
//   「t<數字>-」開頭的代號留給其他租戶，一般邀請（無前綴）不能用；name 1～100 字；machine 1～40 字；kind 不在清單就當 other
//   同一網路位址每小時最多 10 次（429）。邀請碼 15 分鐘有效、只能用一次。
// 金鑰只寫進 ~/.irori-relay/<代號>.key（寫完讀回比對），絕不印出、不放進回傳值。
//
// CLI（邀請碼走環境變數 IRORI_INVITE，不放命令列）：
//   node register.mjs --id <代號> --name <顯示名> --machine <電腦名> [--kind other] [--url <仲介網址>] [--home <家目錄>] [--reissue]
//   node register.mjs --suggest <電腦名> [--prefix <前綴>]      印出建議的代號
//   node register.mjs --check --id <代號>                        用已存的金鑰呼叫 whoami，確認連得上
//   node register.mjs --leave --id <代號>                        離開名單（金鑰立即作廢）
// 每個模式都在標準輸出印一行 JSON（不含金鑰）；成功 exit 0，失敗 exit 1。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_URL = 'https://hwtahctsgjcemtwzlvnq.supabase.co/functions/v1/irori-relay'
export const ID_RE = /^[A-Za-z0-9_-]{1,32}$/
const KINDS = ['claude', 'gpt', 'gemini', 'grok', 'other']

// 後端錯誤碼 → 給一般人看的白話（不含系統內部名詞）
const MESSAGES = {
  bad_request: '填的資料有問題（代號只能用英文、數字、-、_，最多 32 個字；電腦名稱最多 40 個字）。',
  invalid_invite: '邀請碼不對、已經過期（15 分鐘有效）或已經用過。請向希緒或管理者再要一組新的。',
  bad_id_prefix: '這組邀請碼只能註冊指定開頭的代號。',
  id_taken: '這個代號已經有人用了，請換一個。如果是這台電腦以前裝過，請請管理者幫你重發金鑰。',
  rate_limited: '試太多次了，請一小時後再試。',
  network: '連不上伺服器，請檢查網路後再試一次。',
  unauthorized: '金鑰無效或已經作廢。',
  internal: '伺服器暫時有問題，請稍後再試。',
}
const friendly = code => MESSAGES[code] ?? '註冊沒有成功，請稍後再試，或請管理者協助。'

const homeDirOf = home => path.join(home || os.homedir(), '.irori-relay')
const apiUrl = (base, action) => `${String(base || DEFAULT_URL).replace(/\/+$/, '')}?action=${action}`

// 邀請碼限定前綴時，把代號補成合法的（已經以前綴開頭就不動；總長仍 ≤ 32）
export function applyPrefix(id, prefix) {
  if (!prefix || id.startsWith(prefix)) return id
  return `${prefix}${id}`.slice(0, 32)
}

// 由電腦名稱（或現有代號）產生合法代號：非法字元換成 -、頭尾的 - 去掉、最多 32 字；有前綴就補在前面
export function suggestNodeId(computerName, prefix = '') {
  const base = String(computerName ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'PC'
  let id = applyPrefix(base, prefix).slice(0, 32).replace(/-+$/, '')
  if (!prefix && /^t[0-9]+-/.test(id)) id = `pc-${id}`.slice(0, 32)
  return id
}

async function call(fetchImpl, url, { method = 'POST', key, body } = {}) {
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { 'content-type': 'application/json', 'user-agent': 'irori-relay-installer/1', ...(key ? { 'x-relay-key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    return { status: res.status, data }
  } catch {
    return { status: 0, data: { error: 'network' } }
  }
}

export function readSavedKey(id, home) {
  try { return fs.readFileSync(path.join(homeDirOf(home), `${id}.key`), 'utf8').trim() } catch { return '' }
}

// 確認已存的金鑰還有效（whoami）。回傳 { ok, node? }
export async function checkNode({ baseUrl, id, home, fetchImpl = fetch }) {
  const key = readSavedKey(id, home)
  if (!key) return { ok: false, error: 'no_key', message: '這台電腦沒有金鑰檔。' }
  const r = await call(fetchImpl, apiUrl(baseUrl, 'whoami'), { method: 'GET', key })
  if (r.status === 200 && r.data?.node) return { ok: true, node: r.data.node }
  const error = r.data?.error || 'unauthorized'
  return { ok: false, error, status: r.status, message: friendly(error) }
}

// 離開名單：金鑰立即作廢（之後要再加入需要新的邀請碼）
export async function leaveNode({ baseUrl, id, home, fetchImpl = fetch }) {
  const key = readSavedKey(id, home)
  if (!key) return { ok: false, error: 'no_key', message: '這台電腦沒有金鑰檔。' }
  const r = await call(fetchImpl, apiUrl(baseUrl, 'leave'), { key })
  if (r.status === 200 && r.data?.ok) return { ok: true }
  const error = r.data?.error || 'unauthorized'
  return { ok: false, error, status: r.status, message: friendly(error) }
}

// 註冊。成功：寫金鑰檔與 node 檔，回 { ok:true, id, verified }；失敗：{ ok:false, error, message, prefix? }
// reissue：用「重設碼」換新金鑰（這台電腦以前裝過、金鑰不見了）。invite 欄位放重設碼。
export async function registerNode({ baseUrl, invite, id, name, machine, kind = 'other', home, fetchImpl = fetch, reissue = false }) {
  const code = String(invite ?? '').trim()
  if (!code) return { ok: false, error: 'bad_request', message: '還沒有填邀請碼。' }
  if (!ID_RE.test(id ?? '')) return { ok: false, error: 'bad_request', message: friendly('bad_request') }
  const body = reissue
    ? { reissue: code, id }
    : {
        invite: code, id,
        name: String(name || id).slice(0, 100),
        kind: KINDS.includes(kind) ? kind : 'other',
        machine: String(machine || name || id).slice(0, 40),
        note: 'Windows 小程式（收發室橋）',
      }
  const r = await call(fetchImpl, apiUrl(baseUrl, 'register'), { body })
  if (r.status !== 200 || typeof r.data?.key !== 'string' || !r.data.key) {
    const error = r.data?.error || (r.status === 0 ? 'network' : 'internal')
    const out = { ok: false, error, status: r.status, message: friendly(error) }
    if (error === 'bad_id_prefix' && typeof r.data?.prefix === 'string') {
      out.prefix = r.data.prefix
      out.message = `這組邀請碼只能註冊以「${r.data.prefix}」開頭的代號。`
    }
    return out
  }
  const dir = homeDirOf(home)
  fs.mkdirSync(dir, { recursive: true })
  const keyFile = path.join(dir, `${id}.key`)
  fs.writeFileSync(keyFile, r.data.key, 'utf8')
  try { fs.chmodSync(keyFile, 0o600) } catch {}
  if (fs.readFileSync(keyFile, 'utf8').trim() !== r.data.key) {
    return { ok: false, error: 'write_mismatch', message: '金鑰存到這台電腦後讀回不一致，請管理者重發金鑰。' }
  }
  fs.writeFileSync(path.join(dir, 'node'), id, 'utf8')
  const check = await checkNode({ baseUrl, id, home, fetchImpl })
  return { ok: true, id: r.data.id || id, verified: check.ok }
}

// ---- CLI ----
function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (!k.startsWith('--')) continue
    const name = k.slice(2)
    if (['check', 'leave', 'reissue'].includes(name)) a[name] = true
    else a[name] = argv[++i]
  }
  return a
}

export async function main(argv, env = process.env) {
  const a = parseArgs(argv)
  const baseUrl = a.url || env.IRORI_RELAY_URL || DEFAULT_URL
  const home = a.home || undefined
  if (a.suggest !== undefined) return { ok: true, id: suggestNodeId(a.suggest, a.prefix || '') }
  if (a.check) return await checkNode({ baseUrl, id: a.id, home })
  if (a.leave) return await leaveNode({ baseUrl, id: a.id, home })
  return await registerNode({
    baseUrl, invite: env.IRORI_INVITE, id: a.id, name: a.name, machine: a.machine, kind: a.kind || 'other', home, reissue: !!a.reissue,
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const res = await main(process.argv.slice(2))
  process.stdout.write(JSON.stringify(res) + '\n')
  // 不直接 process.exit：Windows 上的 Node 25 在 fetch 連線還在關的時候 exit 會當掉（libuv UV_HANDLE_CLOSING 斷言、結束碼 0xC0000409），安裝程式就會以為註冊失敗
  process.exitCode = res.ok ? 0 : 1
}
