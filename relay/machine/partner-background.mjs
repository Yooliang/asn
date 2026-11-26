// 背景夥伴（ACP）：依 launcher profile 動態啟動工作者。
import fs from 'node:fs'
import path from 'node:path'
import { normalizeWorker } from './engines/acp-config.mjs'

export function workerSpecFromProfile({ name, cwd, profile, workDir }) {
  const acp = profile.acp ?? {}
  const raw = {
    name,
    engine: 'acp',
    protocol: acp.protocol ?? 'agy-stream',
    command: profile.command,
    args: profile.args ?? [],
    cwd,
    roster_engine: acp.roster_engine ?? profile.model ?? 'acp',
    label: profile.label ?? '工作者',
    // 開夥伴開出來的工作者不分廠牌：讀、寫檔、執行指令、上網放行，其他拒絕（#2351；Rust 端 partner_queue.rs 的 permissions_for 同一份）
    permissions: { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', other: 'deny' },
  }
  const r = normalizeWorker(raw, { workDir, index: 0 })
  if (r.error) throw new Error(r.error)
  return r.worker
}

export function ensureWorkerDir(cwd) {
  fs.mkdirSync(cwd, { recursive: true })
}

/** 本機 ASN 送出的背景啟動請求（橋每輪 pull 消化） */
export function createPartnerQueue({ file, log, onLaunch }) {
  const processLine = async line => {
    let req
    try { req = JSON.parse(line) } catch { log(`partner-queue: 無法解析：${line.slice(0, 80)}`); return }
    try { await onLaunch(req) } catch (e) { log(`partner-queue: 啟動失敗 name=${req?.name}: ${e.message}`) }
  }
  return {
    async drain() {
      let text
      try { text = fs.readFileSync(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return; throw e }
      if (!text.trim()) return
      fs.writeFileSync(file, '')
      for (const line of text.split('\n').map(l => l.trim()).filter(Boolean)) await processLine(line)
    },
    enqueue(req) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, JSON.stringify(req) + '\n')
    },
  }
}
