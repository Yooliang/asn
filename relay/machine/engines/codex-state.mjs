// 直接讀 Codex 資料夾（CODEX_HOME，預設 ~/.codex）裡幾個「穩定、只讀」的檔案：
// - session_index.jsonl：thread id ↔ 名字（附加式，後面的行蓋過前面的）。send／recv 認人與名單都靠它
// - thread-writer-locks/<thread-id>.lock：某個行程（TUI／桌面版／codex exec）正開著這個 thread 時持有；
//   Windows 上持有者以不允許共用的方式開著它，所以「試著用 FileShare.None 開開看」開得起來＝沒人在用（檔案可能是被強制結束後留下的殘檔）
// - rollout 檔最後一個 turn_context：該視窗目前的核准／沙盒設定（用來擋「完全存取」的視窗）
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const codexHome = (env = process.env) => env.CODEX_HOME || path.join(os.homedir(), '.codex')

// → { byId: Map<id, name>, byName: Map<name, id[]（舊→新）> }；名字被改成空字串就視為沒有名字
export function readNameIndex(home) {
  const byId = new Map()
  let text = ''
  try { text = fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8') } catch {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let j; try { j = JSON.parse(line) } catch { continue }
    if (typeof j?.id !== 'string') continue
    const name = typeof j.thread_name === 'string' ? j.thread_name.trim() : ''
    if (name) byId.set(j.id, name); else byId.delete(j.id)
  }
  const byName = new Map()
  for (const [id, name] of byId) byName.set(name, [...(byName.get(name) ?? []), id])
  return { byId, byName }
}

const LOCK_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i
const PROBE_PS = [
  '$ErrorActionPreference = "Stop"',
  'foreach ($f in ($env:ASN_LOCK_FILES -split "`n")) {',
  '  if (-not $f) { continue }',
  '  try { $s = [System.IO.File]::Open($f, "Open", "ReadWrite", "None"); $s.Close() }',
  '  catch [System.IO.FileNotFoundException] { }',
  '  catch [System.IO.DirectoryNotFoundException] { }',
  '  catch [System.IO.IOException] { [Console]::Out.WriteLine([System.IO.Path]::GetFileName($f)) }',
  '  catch [System.UnauthorizedAccessException] { [Console]::Out.WriteLine([System.IO.Path]::GetFileName($f)) }',
  '}',
].join('\n')

// 正被某個行程開著的 thread id 集合。
// mode：'auto'（Windows 用 PowerShell 試開；其他平台只看檔案在不在）／'exists'（只看檔案在不在，測試與不支援的平台用）
export async function lockedThreadIds(home, { mode = 'auto', env = process.env, log = () => {} } = {}) {
  const dir = path.join(home, 'thread-writer-locks')
  let names = []
  try { names = fs.readdirSync(dir) } catch { return new Set() }
  const cands = names.map(n => ({ n, m: LOCK_RE.exec(n) })).filter(x => x.m)
  if (!cands.length) return new Set()
  const byFile = new Map(cands.map(x => [x.n.toLowerCase(), x.m[1].toLowerCase()]))
  if (mode === 'exists' || process.platform !== 'win32') return new Set(byFile.values())
  const psExe = path.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(PROBE_PS, 'utf16le').toString('base64')
  const files = cands.map(x => path.join(dir, x.n)).join('\n')
  try {
    const out = await new Promise((resolve, reject) => execFile(psExe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env: { ...env, ASN_LOCK_FILES: files, IRORI_LOCK_FILES: files }, windowsHide: true, timeout: 15_000, encoding: 'utf8' }, (e, so) => (e ? reject(e) : resolve(so))))
    return new Set(String(out).split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(s => byFile.has(s)).map(s => byFile.get(s)))
  } catch (e) {
    log(`codex lock probe failed (${e.message.split('\n')[0]}); 退而求其次：只看鎖檔在不在`)
    return new Set(byFile.values())
  }
}

// rollout（.jsonl）從結尾往回一段一段讀（每段 chunkBytes），找最近一筆 turn_context → { approval, sandbox }；最多讀 maxBytes。
// 舊版只讀最後 1MB：長對話（w02 10/06 實測 16MB、最近的 turn_context 離結尾約 3MB）讀不到就回 null，閘門被放行。
// 回 null＝真的不知道（還沒有任何 turn、讀不到、超過上限）；呼叫端要當成「不能轉信」（fail-closed，見 codex.mjs deliverAsync）
export function readPolicy(rolloutPath, chunkBytes = 1 << 20, maxBytes = 64 << 20) {
  if (!rolloutPath) return null
  let fd
  try {
    fd = fs.openSync(rolloutPath, 'r')
    const size = fs.fstatSync(fd).size
    let pos = size, carry = Buffer.alloc(0)
    while (pos > 0 && size - pos < maxBytes) {
      const len = Math.min(chunkBytes, pos)
      pos -= len
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, pos)
      // carry＝後面那段開頭還沒讀完整的一行（位元組，免得中文字被切在兩段之間解壞），接在這段後面
      let data = Buffer.concat([buf, carry])
      carry = Buffer.alloc(0)
      if (pos > 0) {
        // 還沒到檔案開頭：第一個換行之前那截可能是被切斷的行，留到下一輪跟更前面的內容接起來
        const nl = data.indexOf(0x0a)
        if (nl < 0) { carry = data; continue }
        carry = data.subarray(0, nl)
        data = data.subarray(nl + 1)
      }
      const lines = data.toString('utf8').split(/\r?\n/)
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"type":"turn_context"')) continue
        let j; try { j = JSON.parse(lines[i]) } catch { continue }
        const p = j?.payload
        if (!p) continue
        return { approval: typeof p.approval_policy === 'string' ? p.approval_policy : (p.approval_policy ? 'granular' : ''), sandbox: p.sandbox_policy?.type ?? '' }
      }
    }
  } catch { /* 讀不到就當不知道 */ } finally { if (fd != null) try { fs.closeSync(fd) } catch {} }
  return null
}

// 沙盒是否為「完全存取」（danger-full-access／external-sandbox 都不當成可信的收件視窗）
export const isFullAccess = policy => !!policy && /^(danger-full-access|external-sandbox|externalSandbox|dangerFullAccess)$/.test(policy.sandbox)
