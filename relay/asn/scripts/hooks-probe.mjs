// #2163 PR-3b 第四道證明：行為探針。
// 對執行檔設 ASN_SHOT_LOGIN 後啟動（--shot，只連本機假後端）：
//   - 正式 exe：假後端一定不能收到 node_claim（讀不到測試變數，所以沒有假登入）
//   - hooks 版 exe：一定要收到 node_claim（同一個探針，證明探針本身有效，不是因為壞掉才沒收到）
// 只能在 CI 上跑（會真的開視窗）。用法：node scripts/hooks-probe.mjs --release <正式 exe> --hooks <hooks 版 exe>
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROBE_EMAIL = 'probe@example.com'

/**
 * 判讀一次探針的結果（純函式，方便測試）。
 * r 是 runShot 的回傳；expect 是 'noclaim'（正式版）或 'claim'（hooks 版）。
 * 程式沒正常跑完、或完全沒有活動的結果一律失敗：「沒收到 node_claim」只有在程式確實跑起來時才有意義
 */
export function judgeProbe(r, expect) {
  if (expect !== 'claim' && expect !== 'noclaim') return { ok: false, message: `不認得的期望值：${expect}` }
  if (r.code !== 0) return { ok: false, message: `程式沒正常跑完（結束碼 ${r.code}），探針結果不算數` }
  const reqs = r.relay?.reqs ?? []
  const files = r.files ?? []
  if (reqs.length === 0 && files.length === 0) return { ok: false, message: '程式沒連過假後端、也沒存任何截圖，看不出有沒有跑起來，探針結果不算數' }
  const claims = reqs.filter(q => q.action === 'node_claim').length
  if (expect === 'noclaim') return claims === 0 ? { ok: true, message: '正式版：設了 ASN_SHOT_LOGIN 也沒有 node_claim（符合預期）' } : { ok: false, message: `正式版收到 ${claims} 次 node_claim：測試變數在正式版生效了` }
  return claims > 0 ? { ok: true, message: `hooks 版：收到 ${claims} 次 node_claim（探針有效）` } : { ok: false, message: `hooks 版沒收到 node_claim（請求：${reqs.map(q => q.action).join(',')}）：探針沒有對照組，不能放行` }
}

export async function probe(exe, expect, runShot) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), `asn-probe-${expect}-`))
  const r = await runShot(out, exe, { login: PROBE_EMAIL, noTabs: true, timeoutMs: 120_000 })
  const j = judgeProbe(r, expect)
  return { ...j, message: `${exe}：${j.message}`, log: r.log }
}

export function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--release' || argv[i] === '--hooks') { o[argv[i].slice(2)] = argv[++i]; if (!o[argv[i - 1].slice(2)]) return { error: `${argv[i - 1]} 後面要接檔案` } }
    else return { error: `不認得的參數：${argv[i]}` }
  }
  if (!o.release || !o.hooks) return { error: '一定要同時給 --release 與 --hooks，只驗一邊會假綠' }
  return o
}

export async function main(argv = process.argv.slice(2)) {
  const p = parseArgs(argv)
  if (p.error) { console.error(`行為探針：${p.error}`); return 2 }
  const { runShot } = await import('./shot.mjs')
  let bad = 0
  for (const [exe, expect] of [[p.hooks, 'claim'], [p.release, 'noclaim']]) {
    const r = await probe(exe, expect, runShot)
    console.log(`${r.ok ? '通過' : '失敗'}：${r.message}`)
    if (!r.ok) { bad++; console.log(String(r.log ?? '').trim().split('\n').slice(-30).join('\n')) }
  }
  return bad === 0 ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main())
