// 端到端截圖：起本機假 relay，用 `asn.exe --shot <資料夾>` 跑一次真的程式（名單＋一個對話＋一則提示），
// 程式自己用螢幕擷取存 PNG 後結束。全程只連 127.0.0.1 的假後端，不碰真實 relay、不用真實金鑰。
//   node scripts/shot.mjs <輸出資料夾> [exe 路徑]
//   ASN_SHOT_NOKEY=1 node scripts/shot.mjs <輸出資料夾>   模擬沒有節點金鑰的新電腦，只截登入畫面（tabs-login.png）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { FAKE_KEY, startFakeRelay } from '../test/fake-relay.mjs'
import { demoUploadUrl, pngDataUrl } from '../test/png.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseName = process.platform === 'win32' ? 'asn.exe' : 'asn'
export const defaultExe = path.join(root, 'src-tauri', 'target', 'release', releaseName)
function scrotOnPath() {
  if (process.platform !== 'linux') return false
  try { return spawnSync('scrot', ['--version'], { stdio: 'ignore' }).status === 0 } catch { return false }
}
export const shotCaptureSupported = process.platform === 'win32' || scrotOnPath()

// asn：各設備上 ASN 回報的在線狀態與版本（牧陽沒有 ASN＝名單上不顯示小綠點；工作機是舊版＝顯示「有新版」）
const demoAsn = { H: [{ window_name: 'H-ASN', version: '0.1.13', status: 'online', psm: '' }], W: [{ window_name: 'W-ASN', version: '0.1.12', status: 'busy', psm: '' }], G: [{ window_name: 'G-ASN', version: '0.1.13', status: 'away', psm: '' }] }
export const demoMembers = [
  { id: 'H', name: '家用機', kind: 'claude', agents: [
    { name: 'H-ASN', status: 'idle', cwd_label: 'asn' },
    { name: '家用收發室', status: 'idle', cwd_label: 'relay' },
    { name: 'H-Irori', status: 'idle', cwd_label: 'irori', engine: 'claude' },
    { name: 'H-島作', status: 'working', cwd_label: 'IslandMade', engine: 'claude' },
  ] },
  { id: 'W', name: '工作機', kind: 'claude', agents: [
    { name: 'W-新視窗', status: 'idle', cwd_label: 'scratch' },   // 沒回報 engine：用節點 kind 推斷成 Claude
    { name: 'W-政策', status: 'idle', cwd_label: 'policy-tw', engine: 'claude' },
    { name: 'W-日本', status: 'busy', cwd_label: 'policy-jp', engine: 'claude' },
  ] },
  { id: 'aegis', name: '牧陽 Aegis', kind: 'other', agents: [{ name: '小牧', status: 'idle', cwd_label: 'aegis' }, { name: '小陽', status: 'waiting', cwd_label: 'ops' }] },
  { id: 'G', name: 'Grok 機', kind: 'grok', agents: [{ name: 'G-研究', status: 'idle', cwd_label: 'lab' }] },
]

export const demoRooms = [
  { id: 'room-policy', name: '正見群', created_at: '2026-10-10T00:00:00Z', last_at: '2026-10-20T07:30:00Z', last_from_name: 'W-政策', last_body: '今天的資料都補完了', members: [{}, {}, {}, {}] },
  { id: 'room-irori', name: '希緒開發', created_at: '2026-10-12T00:00:00Z', members: [{}, {}] },
]

// me：預先寫進 asn-me.json 的設定（例如 { tabDim: 'engine', groupDim: 'device' }），截圖時用來切換維度
// avatars：true＝示範大頭貼（本機這台 H 已上傳一張；另有不在名單上的設備 K 也上傳了一張，並寄來一封信）
export async function runShot(outDir, exe = defaultExe, { timeoutMs = 90_000, me = null, avatars = false, setup = null, noKey = false, acctRemote = {} } = {}) {
  const all = avatars ? [...demoMembers, { id: 'K', name: '小凱的電腦', kind: 'other', agents: [] }] : demoMembers
  const members = all.map(m => (demoAsn[m.id] ? { ...m, asn: demoAsn[m.id] } : m))
  const relay = await startFakeRelay({ node: 'H', members, rooms: demoRooms, acctRemote, avatars: avatars ? { H: demoUploadUrl(), K: pngDataUrl(96, 96, (x, y) => (((x >> 4) + (y >> 4)) % 2 ? [70, 130, 200] : [250, 210, 90])) } : {} })
  if (avatars) relay.mail(3, { from_node: 'K', from_agent: 'K-ASN', to_node: 'H', to_agent: 'H-ASN', body: '嗨，我是另一台的 ASN 使用者 :)', created_at: new Date(Date.now() - 60_000).toISOString() })
  relay.mail(1, { from_node: 'W', from_agent: 'W-政策', to_node: 'H', to_agent: 'H-ASN', body: '資料補完了，幫我看一下 (Y)\n明天要上線 :)', created_at: new Date(Date.now() - 4 * 60_000).toISOString() })
  // 改名後的舊名：還沒過期，所以 asn.exe 也要用 inbox&agent=H-舊名 收信、對同一個名字 ack、並寫它的心跳
  relay.mail(2, { from_node: 'W', from_agent: 'W-政策', to_node: 'H', to_agent: 'H-舊名', body: '這封是寄給改名前的名字', created_at: new Date(Date.now() - 2 * 60_000).toISOString() })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-shot-'))
  const env = {
    ...process.env, IRORI_RELAY_URL: relay.url, IRORI_RELAY_ID: 'H', IRORI_RELAY_KEY: FAKE_KEY, IRORI_RELAY_ANON_KEY: '',
    USERPROFILE: path.join(tmp, 'home'), HOME: path.join(tmp, 'home'), IRORI_ASN_DATA: path.join(tmp, 'data'), WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
  }
  // noKey：模擬沒有節點金鑰的新電腦（只截登入畫面）；家目錄是暫存的空資料夾，這裡再把身分環境變數清掉，免得吃到使用者自己的
  if (noKey) { delete env.IRORI_RELAY_ID; delete env.IRORI_RELAY_KEY }
  if (process.platform === 'linux') {
    env.WEBKIT_DISABLE_COMPOSITING_MODE = '1'
    env.WEBKIT_DISABLE_DMABUF_RENDERER = '1'
  }
  fs.mkdirSync(env.USERPROFILE, { recursive: true })
  fs.mkdirSync(env.IRORI_ASN_DATA, { recursive: true })
  fs.writeFileSync(path.join(env.IRORI_ASN_DATA, 'settings.json'), JSON.stringify({ window_name: 'H-ASN', old_names: [{ name: 'H-舊名', t: Date.now() - 60_000 }, { name: 'H-過期', t: Date.now() - 9 * 24 * 3600_000 }] }))
  if (me) fs.writeFileSync(path.join(env.IRORI_ASN_DATA, 'asn-me.json'), JSON.stringify(me))
  if (setup) setup(env)   // 截圖前預先放好暫存家目錄裡的檔案（例如假的 ~/.claude/sessions）
  const child = spawn(exe, ['--shot', outDir], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false, detached: process.platform !== 'win32' })
  let log = ''
  child.stdout.on('data', d => (log += d)); child.stderr.on('data', d => (log += d))
  const pid = child.pid   // 只關自己啟動的這一個（含它的 WebView2 子程序）
  // 程式結束時會清掉自己的心跳檔，所以執行中輪詢，記下看到的內容
  const hbFile = path.join(env.USERPROFILE, '.irori-relay', 'machine-H', 'self-recv', 'H-ASN.json')
  let heartbeat = null, oldHeartbeat = null, expiredHeartbeat = false
  const oldHb = path.join(path.dirname(hbFile), 'H-舊名.json'), expHb = path.join(path.dirname(hbFile), 'H-過期.json')
  const poll = setInterval(() => { try { heartbeat ??= JSON.parse(fs.readFileSync(hbFile, 'utf8')) } catch {}; try { oldHeartbeat ??= JSON.parse(fs.readFileSync(oldHb, 'utf8')) } catch {}; if (fs.existsSync(expHb)) expiredHeartbeat = true }, 100)
  const killTree = () => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'])
    else { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} } }
  }
  const code = await new Promise(res => {
    const t = setTimeout(() => { killTree(); res('timeout') }, timeoutMs)
    child.on('exit', c => { clearTimeout(t); res(c) })
  })
  clearInterval(poll)
  const result = { code, log, heartbeat, oldHeartbeat, expiredHeartbeat, hbFile, relay, tmp, home: env.USERPROFILE, data: env.IRORI_ASN_DATA, pid, files: fs.existsSync(outDir) ? fs.readdirSync(outDir) : [] }
  await relay.close()
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] ?? 'shots')
  // 第三個參數之後：exe 路徑；環境變數 ASN_SHOT_ME 可放 JSON 設定（如 {"tabDim":"engine","groupDim":"device"}）；
  // 整合模式是 {"winMode":"merged"}（欄位名是 winMode，不是 mode），再加 "shotNoChat":true 就不開任何對話、停在「開始」大幅廣告；
  // "shotAd":N 固定停在第 N 則廣告；"shotTab":"guide" 指定起始頁籤
  const r = await runShot(out, process.argv[3] ?? defaultExe, { me: process.env.ASN_SHOT_ME ? JSON.parse(process.env.ASN_SHOT_ME) : null, avatars: process.env.ASN_SHOT_AVATARS === '1', noKey: process.env.ASN_SHOT_NOKEY === '1' })
  console.log(`exit=${r.code} files=${r.files.join(',')} sent=${r.relay.sent.length}`)
  if (r.log.trim()) console.log(r.log.trim())
  process.exit(r.code === 0 ? 0 : 1)
}
