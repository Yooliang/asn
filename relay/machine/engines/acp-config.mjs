// agents.json（~/.asn/agents.json；範本 relay/machine/agents.example.json）的讀取與檢查。
// 一個壞掉的工作者條目只跳過那一條（log 寫原因），不影響其他條目；整個檔案壞掉或不存在＝沒有工作者。
import fs from 'node:fs'
import path from 'node:path'
import { normalizePermissions } from './acp-policy.mjs'

export const PROTOCOLS = ['agy-stream', 'acp']
const NAME_RE = /^[A-Za-z0-9一-鿿][A-Za-z0-9一-鿿-]{0,39}$/
const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i
const num = (v, d, min = 1) => { const n = Number(v); return Number.isFinite(n) && n >= min ? n : d }

// 授權詢問要寄給誰：'sender'（預設，原寄件人）或 { node, agent? } 或它們的陣列
function normalizeNotify(raw, warnings) {
  const list = raw === undefined ? ['sender'] : Array.isArray(raw) ? raw : [raw]
  const out = []
  for (const x of list) {
    if (x === 'sender') out.push({ sender: true })
    else if (x && typeof x.node === 'string' && x.node.trim()) out.push({ node: x.node.trim(), agent: typeof x.agent === 'string' && x.agent.trim() ? x.agent.trim() : undefined })
    else warnings.push(`ask.notify 有一項看不懂，已忽略：${JSON.stringify(x)}`)
  }
  return out.length ? out : [{ sender: true }]
}

export function normalizeWorker(raw, { workDir, index }) {
  const warnings = []
  const fail = reason => ({ error: `workers[${index}]${raw?.name ? `（${raw.name}）` : ''}：${reason}` })
  if (!raw || typeof raw !== 'object') return fail('不是物件')
  if (raw.engine !== 'acp') return fail(`engine 必須是 "acp"（收到 ${JSON.stringify(raw.engine)}）`)
  if (typeof raw.name !== 'string' || !NAME_RE.test(raw.name)) return fail('name 只能是字母、數字、中文、連字號，最長 40 字，且不能以 - 開頭')
  const protocol = raw.protocol ?? 'agy-stream'
  if (!PROTOCOLS.includes(protocol)) return fail(`protocol 必須是 ${PROTOCOLS.join(' 或 ')}`)
  if (typeof raw.command !== 'string' || !raw.command.trim()) return fail('缺 command')
  if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some(a => typeof a !== 'string'))) return fail('args 必須是字串陣列')
  const cwd = path.resolve(typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd : path.join(workDir, 'workers', raw.name))
  const envPass = Array.isArray(raw.env_pass) ? raw.env_pass.filter(n => typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) : []
  for (const n of envPass) if (SECRET_NAME_RE.test(n)) return fail(`env_pass 不可放像金鑰的變數名稱（${n}）；登入狀態讀各 CLI 自己的憑證檔`)
  const perms = normalizePermissions(raw.permissions, cwd)
  warnings.push(...perms.warnings)
  // agy 原生模式沒有「執行到一半問人」的管道：只有指令可以事後問，寫檔／上網的 ask 一律降成 deny
  if (protocol === 'agy-stream') {
    for (const c of ['write', 'network', 'other']) if (perms.rules[c] === 'ask') { perms.rules[c] = 'deny'; warnings.push(`protocol=agy-stream 的 ${c} 不能設 ask（agy 無法在執行前暫停），已當成 deny`) }
  }
  const ask = raw.ask && typeof raw.ask === 'object' ? raw.ask : {}
  return {
    worker: {
      name: raw.name, protocol, command: raw.command.trim(), args: raw.args ?? [], cwd,
      rosterEngine: typeof raw.roster_engine === 'string' && raw.roster_engine.trim() ? raw.roster_engine.trim().slice(0, 20) : 'acp',
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 80) : '工作者',
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : '',
      authMethod: typeof raw.auth_method === 'string' && raw.auth_method.trim() ? raw.auth_method.trim() : '',
      envPass, permissions: perms,
      ask: { notify: normalizeNotify(ask.notify, warnings), timeoutMs: num(ask.timeout_ms, 300_000, 100) },
      turnTimeoutMs: num(raw.turn_timeout_ms, 300_000, 100),     // 這麼久「完全沒有動靜」就中止這一輪
      turnMaxMs: num(raw.turn_max_ms, 1_800_000, 100),           // 一輪的總上限（含等人授權的時間）
      queueMax: num(raw.queue_max, 10),
    },
    warnings,
  }
}

// 回傳 { workers, errors, warnings, file }
export function loadWorkersConfig({ file, workDir }) {
  const out = { workers: [], errors: [], warnings: [], file }
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) {
    if (e.code !== 'ENOENT') out.errors.push(`讀不到 ${file}：${e.message}`)
    return out
  }
  let cfg
  try { cfg = JSON.parse(text.replace(/^﻿/, '')) } catch (e) { out.errors.push(`${file} 不是合法的 JSON：${e.message}`); return out }
  if (!cfg || !Array.isArray(cfg.workers)) { out.errors.push(`${file} 缺少 workers 陣列`); return out }
  const seen = new Set()
  cfg.workers.forEach((raw, index) => {
    if (raw && raw.enabled === false) return   // 範本裡的備援條目用 enabled:false 關著
    const r = normalizeWorker(raw, { workDir, index })
    if (r.error) { out.errors.push(r.error); return }
    const key = r.worker.name.toLowerCase()
    if (seen.has(key)) { out.errors.push(`workers[${index}]（${r.worker.name}）：名稱重複`); return }
    seen.add(key)
    out.workers.push(r.worker)
    out.warnings.push(...r.warnings.map(w => `${r.worker.name}：${w}`))
  })
  return out
}
