// 端到端截圖：起本機假 relay，用 `asn.exe --shot <資料夾>` 跑一次真的程式（名單＋一個對話＋一則提示），
// 程式自己用螢幕擷取存 PNG 後結束。全程只連 127.0.0.1 的假後端，不碰真實 relay、不用真實金鑰。
//   node scripts/shot.mjs <輸出資料夾> [exe 路徑]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { FAKE_KEY, startFakeRelay } from '../test/fake-relay.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const defaultExe = path.join(root, 'src-tauri', 'target', 'release', 'asn.exe')

export const demoMembers = [
  { id: 'H', name: '家用機', agents: [
    { name: 'H-ASN', status: 'idle', cwd_label: 'asn' },
    { name: '家用收發室', status: 'idle', cwd_label: 'relay' },
    { name: 'H-Irori', status: 'idle', cwd_label: 'irori', engine: 'claude' },
    { name: 'H-島作', status: 'working', cwd_label: 'IslandMade', engine: 'claude' },
  ] },
  { id: 'W', name: '工作機', agents: [
    { name: 'W-政策', status: 'idle', cwd_label: 'policy-tw', engine: 'claude' },
    { name: 'W-日本', status: 'busy', cwd_label: 'policy-jp', engine: 'claude' },
  ] },
  { id: 'aegis', name: '牧陽 Aegis', agents: [{ name: '小牧', status: 'idle', cwd_label: 'aegis', engine: 'claude' }] },
]

export const demoRooms = [
  { id: 'room-policy', name: '正見群', created_at: '2026-10-10T00:00:00Z', last_at: '2026-10-20T07:30:00Z', last_from_name: 'W-政策', last_body: '今天的資料都補完了', members: [{}, {}, {}, {}] },
  { id: 'room-irori', name: '希緒開發', created_at: '2026-10-12T00:00:00Z', members: [{}, {}] },
]

export async function runShot(outDir, exe = defaultExe, { timeoutMs = 90_000 } = {}) {
  const relay = await startFakeRelay({ node: 'H', members: demoMembers, rooms: demoRooms })
  relay.mail(1, { from_node: 'W', from_agent: 'W-政策', to_node: 'H', to_agent: 'H-ASN', body: '資料補完了，幫我看一下 (Y)\n明天要上線 :)', created_at: new Date(Date.now() - 4 * 60_000).toISOString() })
  // 改名後的舊名：還沒過期，所以 asn.exe 也要用 inbox&agent=H-舊名 收信、對同一個名字 ack、並寫它的心跳
  relay.mail(2, { from_node: 'W', from_agent: 'W-政策', to_node: 'H', to_agent: 'H-舊名', body: '這封是寄給改名前的名字', created_at: new Date(Date.now() - 2 * 60_000).toISOString() })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-shot-'))
  const env = {
    ...process.env, IRORI_RELAY_URL: relay.url, IRORI_RELAY_ID: 'H', IRORI_RELAY_KEY: FAKE_KEY, IRORI_RELAY_ANON_KEY: '',
    USERPROFILE: path.join(tmp, 'home'), HOME: path.join(tmp, 'home'), IRORI_ASN_DATA: path.join(tmp, 'data'), WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
  }
  fs.mkdirSync(env.USERPROFILE, { recursive: true })
  fs.mkdirSync(env.IRORI_ASN_DATA, { recursive: true })
  fs.writeFileSync(path.join(env.IRORI_ASN_DATA, 'settings.json'), JSON.stringify({ window_name: 'H-ASN', old_names: [{ name: 'H-舊名', t: Date.now() - 60_000 }, { name: 'H-過期', t: Date.now() - 9 * 24 * 3600_000 }] }))
  const child = spawn(exe, ['--shot', outDir], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
  let log = ''
  child.stdout.on('data', d => (log += d)); child.stderr.on('data', d => (log += d))
  const pid = child.pid   // 只關自己啟動的這一個（含它的 WebView2 子程序）
  // 程式結束時會清掉自己的心跳檔，所以執行中輪詢，記下看到的內容
  const hbFile = path.join(env.USERPROFILE, '.irori-relay', 'machine-H', 'self-recv', 'H-ASN.json')
  let heartbeat = null, oldHeartbeat = null, expiredHeartbeat = false
  const oldHb = path.join(path.dirname(hbFile), 'H-舊名.json'), expHb = path.join(path.dirname(hbFile), 'H-過期.json')
  const poll = setInterval(() => { try { heartbeat ??= JSON.parse(fs.readFileSync(hbFile, 'utf8')) } catch {}; try { oldHeartbeat ??= JSON.parse(fs.readFileSync(oldHb, 'utf8')) } catch {}; if (fs.existsSync(expHb)) expiredHeartbeat = true }, 100)
  const code = await new Promise(res => {
    const t = setTimeout(() => { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']); res('timeout') }, timeoutMs)
    child.on('exit', c => { clearTimeout(t); res(c) })
  })
  clearInterval(poll)
  const result = { code, log, heartbeat, oldHeartbeat, expiredHeartbeat, hbFile, relay, tmp, home: env.USERPROFILE, data: env.IRORI_ASN_DATA, pid, files: fs.existsSync(outDir) ? fs.readdirSync(outDir) : [] }
  await relay.close()
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] ?? 'shots')
  const r = await runShot(out, process.argv[3] ?? defaultExe)
  console.log(`exit=${r.code} files=${r.files.join(',')} sent=${r.relay.sent.length}`)
  if (r.log.trim()) console.log(r.log.trim())
  process.exit(r.code === 0 ? 0 : 1)
}
