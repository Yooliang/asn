// 隔離的 ASN 實例：暫存家目錄、本機假後端，不碰真實 relay 與真實帳號。node iso.mjs <flags資料夾> [mux]
// 跑到 flags\done 出現或 25 分鐘；只關自己啟動的那一個程序樹。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn, spawnSync } from 'node:child_process'; import { pathToFileURL } from 'node:url'
const repo = 'D:/Github/Yooliang/asn-15q/relay/asn'
const [flags, mode] = process.argv.slice(2)
const { FAKE_KEY, startFakeRelay } = await import(pathToFileURL(path.join(repo, 'test/fake-relay.mjs')).href)
const { demoMembers, demoRooms } = await import(pathToFileURL(path.join(repo, 'scripts/shot.mjs')).href)
fs.mkdirSync(flags, { recursive: true })
const relay = await startFakeRelay({ node: 'H', members: demoMembers, rooms: demoRooms })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-iso-'))
const home = path.join(tmp, 'home'), data = path.join(tmp, 'data'), local = path.join(tmp, 'local')
for (const d of [home, data, local]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ window_name: 'H-ASN' }))
fs.writeFileSync(path.join(data, 'login_skipped'), '1')
const env = {
  ...process.env, ASN_RELAY_URL: relay.url, ASN_RELAY_ID: 'H', ASN_RELAY_KEY: FAKE_KEY, ASN_RELAY_ANON_KEY: '',
  USERPROFILE: home, HOME: home, LOCALAPPDATA: local, ASN_DATA: data, WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'wv2'),
  ASN_WEZTERM_DIR: 'C:\\Users\\cwen0708\\AppData\\Local\\ASN\\wezterm',
  ASN_TERM_WEZTERM: '1', ASN_SCREEN_WATCH: '1',
}
if (mode === 'mux') env.ASN_TERM_MUX = '1'
if (mode === 'broken') env.ASN_WEZTERM_DIR = 'C:/no-such-wezterm-15q'
for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k]
const exe = path.join(repo, 'src-tauri/target/release/asn.exe')
let child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
const log = fs.createWriteStream(path.join(flags, 'asn.log'))
child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
fs.writeFileSync(path.join(flags, 'started'), JSON.stringify({ pid: child.pid, tmp, url: relay.url }))
console.log('ASN pid', child.pid, 'tmp', tmp)
const t0 = Date.now(); let respawned = false
while (!fs.existsSync(path.join(flags, 'done')) && Date.now() - t0 < 25 * 60_000) {
  if (child.exitCode !== null || child.signalCode) {
    if (!respawned && fs.existsSync(path.join(flags, 'respawn'))) {
      respawned = true
      child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
      fs.writeFileSync(path.join(flags, 'restarted'), String(child.pid))
    } else if (respawned) break
  }
  await new Promise(r => setTimeout(r, 300))
}
console.log('結束碼', child.exitCode)
if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])
for (const f of ['ui.log']) { const p = path.join(home, '.asn', 'machine-H', f); if (fs.existsSync(p)) fs.copyFileSync(p, path.join(flags, f)) }
const m = path.join(local, 'ASN', 'm', 'mux.log'); if (fs.existsSync(m)) fs.copyFileSync(m, path.join(flags, 'mux.log'))
const j = path.join(data, 'wezterm-terms.json'); if (fs.existsSync(j)) fs.copyFileSync(j, path.join(flags, 'terms.json'))
fs.writeFileSync(path.join(flags, 'relay-launches.json'), JSON.stringify(relay.launches ?? null))
await relay.close(); process.exit(0)
