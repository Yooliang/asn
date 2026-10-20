// 量閒置記憶體：開 asn.exe（假 relay、只有名單視窗）等 25 秒，加總它與 WebView2 子程序的工作集，再只關這棵樹。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { FAKE_KEY, startFakeRelay } from '../test/fake-relay.mjs'
import { defaultExe, demoMembers } from './shot.mjs'

const relay = await startFakeRelay({ node: 'H', members: demoMembers })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-mem-'))
const env = { ...process.env, IRORI_RELAY_URL: relay.url, IRORI_RELAY_ID: 'H', IRORI_RELAY_KEY: FAKE_KEY, IRORI_RELAY_ANON_KEY: '', USERPROFILE: tmp, HOME: tmp, IRORI_ASN_DATA: path.join(tmp, 'd'), WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, 'w') }
const child = spawn(process.argv[2] ?? defaultExe, [], { env, stdio: 'ignore' })
await new Promise(r => setTimeout(r, 25_000))
const ps = `$all=Get-CimInstance Win32_Process; $ids=@(${child.pid}); do{$n=$ids.Count; $ids=@($ids)+@($all|?{$ids -contains $_.ParentProcessId}|%{$_.ProcessId})|sort -Unique}while($ids.Count -gt $n); $all|?{$ids -contains $_.ProcessId}|%{ "$($_.Name) $($_.ProcessId) $([math]::Round($_.WorkingSetSize/1MB,1))" }`
console.log(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }))
spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])
await relay.close()
