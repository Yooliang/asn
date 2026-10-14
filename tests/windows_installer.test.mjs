// Windows 安裝／解除安裝程式（node --test tests/windows_installer.test.mjs）。
// 把打好的 zip 解開到暫存資料夾，用暫存的家目錄（-HomeDir）跑 install.ps1／uninstall.ps1，對本機假伺服器註冊。
// 不碰真的 ~/.irori-relay、不建任何排程（-NoSchedule）、不連真的仲介。只有 Windows 才跑。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { buildDownloads } from '../tools/release/build_downloads.mjs'
import { listZip } from '../tools/release/zip_lite.mjs'
import { fakeRelay } from './_fake_relay.mjs'

const WIN = process.platform === 'win32'
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p))
let pkg
function extracted() {
  pkg ??= buildDownloads({ outDir: tmp('irori-inst-dl-') })
  const dir = tmp('irori-inst-x-')
  for (const e of listZip(fs.readFileSync(pkg.zipPath))) {
    const f = path.join(dir, ...e.name.split('/'))
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, e.data)
  }
  return dir
}
function ps(script, args, { stdin = '', timeoutMs = 90_000 } = {}) {
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => { out += d.toString('utf8') })
    child.stderr.on('data', d => { out += d.toString('utf8') })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('close', code => { clearTimeout(timer); resolve({ code, out: out.replace(/﻿/g, '') }) })
    child.stdin.end(stdin)
  })
}
const irori = home => path.join(home, '.irori-relay')
const dirEntries = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [])
const base = ['-NonInteractive', '-NoSchedule']

test('預覽（-WhatIf）：安裝與解除安裝都不改任何東西、不連網', { skip: !WIN }, async () => {
  const srv = await fakeRelay({ invites: { X: {} } })
  const x = extracted(), home = tmp('irori-home-')
  const a = await ps(path.join(x, 'install.ps1'), ['-WhatIf', '-HomeDir', home, '-BaseUrl', srv.url])
  assert.equal(a.code, 0, a.out)
  assert.match(a.out, /預覽/)
  assert.match(a.out, /邀請碼/)
  const u = await ps(path.join(x, 'uninstall.ps1'), ['-WhatIf', '-HomeDir', home, '-BaseUrl', srv.url])
  assert.equal(u.code, 0, u.out)
  assert.deepEqual(dirEntries(home), [], '預覽不能建任何檔案')
  assert.equal(srv.reqs.length, 0, '預覽不能連網')
  await srv.close()
})

test('完整流程：註冊 → 金鑰與 node 檔 → 程式複製 → 再跑一次變「更新」不重註冊 → 解除安裝（含離開名單與刪除資料）', { skip: !WIN }, async () => {
  const srv = await fakeRelay({ invites: { GOOD1: {} } })
  const x = extracted(), home = tmp('irori-home-')
  const r = await ps(path.join(x, 'install.ps1'), [...base, '-InviteCode', 'GOOD1', '-NodeId', 'T-pc1', '-DisplayName', '小美的筆電', '-HomeDir', home, '-BaseUrl', srv.url])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /註冊成功/)
  assert.match(r.out, /裝好了/)
  // 金鑰：存在、與伺服器發的一致、沒有印出來
  const key = fs.readFileSync(path.join(irori(home), 'T-pc1.key'), 'utf8')
  assert.equal(key, srv.issued[0])
  assert.ok(!r.out.includes(key), '輸出不能含金鑰')
  assert.equal(fs.readFileSync(path.join(irori(home), 'node'), 'utf8'), 'T-pc1')
  assert.ok(fs.existsSync(path.join(irori(home), 'app', 'bridge.mjs')))
  assert.ok(fs.existsSync(path.join(irori(home), 'app', 'VERSION.json')))
  assert.ok(fs.existsSync(path.join(irori(home), 'uninstall', 'uninstall.ps1')) && fs.existsSync(path.join(irori(home), 'uninstall', 'irori-common.ps1')))
  assert.deepEqual(srv.registers.map(b => [b.id, b.name, b.kind]), [['T-pc1', '小美的筆電', 'other']])
  assert.ok(srv.reqs.some(q => q.action === 'whoami'), '裝完要確認連線')

  // 裝好的 app 真的能跑（不在 Claude 視窗裡的 send.mjs 會拒絕，但程式載得起來、認得節點）
  const sendOut = await new Promise(res => {
    const c = spawn(process.execPath, [path.join(irori(home), 'app', 'send.mjs'), '--whoami'], { env: { ...process.env, USERPROFILE: home, HOME: home }, windowsHide: true })
    let o = ''; c.stdout.on('data', d => { o += d }); c.stderr.on('data', d => { o += d }); c.on('close', code => res({ code, o }))
  })
  assert.ok(!/Cannot find module|ERR_MODULE_NOT_FOUND/.test(sendOut.o), sendOut.o)

  // 排程：只看 install-task.ps1 的預覽（不加 -Apply，不會真的建立），確認指到裝好的 run-bridge.ps1
  const tp = await ps(path.join(irori(home), "app", "install-task.ps1"), ["-NodeId", "T-pc1"])
  assert.match(tp.out, /IroriRelayMachine-T-pc1/); assert.ok(tp.out.includes(path.join(irori(home), "app", "run-bridge.ps1")), tp.out)

  // 第二次：已安裝 → 更新模式。改掉 app 裡的檔案，更新後應被換回；不再註冊
  const regsBefore = srv.registers.length
  fs.writeFileSync(path.join(irori(home), 'app', 'bridge.mjs'), '// tampered')
  fs.writeFileSync(path.join(irori(home), 'app', 'stale-old-file.mjs'), '// 舊版留下的')
  const up = await ps(path.join(x, 'install.ps1'), [...base, '-HomeDir', home, '-BaseUrl', srv.url])
  assert.equal(up.code, 0, up.out)
  assert.match(up.out, /只更新程式/)
  assert.equal(srv.registers.length, regsBefore, '更新不能重新註冊')
  assert.notEqual(fs.readFileSync(path.join(irori(home), 'app', 'bridge.mjs'), 'utf8'), '// tampered')
  assert.ok(!fs.existsSync(path.join(irori(home), 'app', 'stale-old-file.mjs')), '更新要清掉舊版殘留')
  assert.equal(fs.readFileSync(path.join(irori(home), 'T-pc1.key'), 'utf8'), key, '更新不動金鑰')
  assert.ok(!up.out.includes(key))

  // 預覽更新：不動檔案
  fs.writeFileSync(path.join(irori(home), 'app', 'bridge.mjs'), '// marker')
  const pv = await ps(path.join(x, 'install.ps1'), ['-WhatIf', '-HomeDir', home, '-BaseUrl', srv.url])
  assert.equal(pv.code, 0, pv.out)
  assert.equal(fs.readFileSync(path.join(irori(home), 'app', 'bridge.mjs'), 'utf8'), '// marker')

  // 解除安裝：只結束 pid 檔記的兩個程序，不碰旁邊的；刪資料並離開名單
  const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 120000)'], { stdio: 'ignore', windowsHide: true })
  const bridge = sleeper(), mailbox = sleeper(), bystander = sleeper()
  try {
    await new Promise(r => setTimeout(r, 400))
    const work = path.join(irori(home), 'machine-T-pc1')
    fs.mkdirSync(work, { recursive: true })
    fs.writeFileSync(path.join(work, 'bridge.pid'), String(bridge.pid))
    fs.writeFileSync(path.join(work, 'mailbox.pid'), String(mailbox.pid))
    const un = await ps(path.join(irori(home), 'uninstall', 'uninstall.ps1'), ['-NonInteractive', '-DeleteData', '-Leave', '-HomeDir', home, '-BaseUrl', srv.url])
    assert.equal(un.code, 0, un.out)
    await new Promise(r => setTimeout(r, 400))
    const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
    assert.equal(alive(bridge.pid), false, 'bridge.pid 記的程序要被停掉')
    assert.equal(alive(mailbox.pid), false, 'mailbox.pid 記的程序要被停掉')
    assert.equal(alive(bystander.pid), true, '沒記在 pid 檔的程序絕不能碰')
    assert.ok(srv.reqs.some(q => q.action === 'leave'), '要通知仲介離開名單')
    assert.deepEqual(dirEntries(irori(home)).filter(n => n !== 'uninstall'), [], '金鑰與資料夾都刪掉')
    assert.ok(!fs.existsSync(path.join(irori(home), 'T-pc1.key')))
    assert.ok(!un.out.includes(key))
  } finally {
    for (const c of [bridge, mailbox, bystander]) { try { c.kill() } catch { /* 已結束 */ } }
  }
  await srv.close()
})

test('解除安裝：不刪資料時金鑰留著；pid 檔過期（pid 已被別的程式重用）不結束那個程序', { skip: !WIN }, async () => {
  const x = extracted(), home = tmp('irori-home-')
  const work = path.join(irori(home), 'machine-K1')
  fs.mkdirSync(work, { recursive: true })
  fs.writeFileSync(path.join(irori(home), 'node'), 'K1')
  fs.writeFileSync(path.join(irori(home), 'K1.key'), 'keep-me')
  const innocent = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore', windowsHide: true })
  try {
    await new Promise(r => setTimeout(r, 400))
    const pidFile = path.join(work, 'bridge.pid')
    fs.writeFileSync(pidFile, String(innocent.pid))
    const old = new Date(Date.now() - 3600_000)
    fs.utimesSync(pidFile, old, old) // pid 檔比那個程序還舊 → 當作 pid 被重用
    const un = await ps(path.join(x, 'uninstall.ps1'), ['-NonInteractive', '-KeepData', '-HomeDir', home])
    assert.equal(un.code, 0, un.out)
    assert.doesNotThrow(() => process.kill(innocent.pid, 0), '重用 pid 的程序不能被結束')
    assert.equal(fs.readFileSync(path.join(irori(home), 'K1.key'), 'utf8'), 'keep-me')
    assert.match(un.out, /已保留/)
  } finally { try { innocent.kill() } catch { /* 已結束 */ } }
})

test('邀請碼限定前綴：代號沒帶前綴時自動補上再試一次', { skip: !WIN }, async () => {
  const srv = await fakeRelay({ invites: { PFX: { prefix: 'W-' } } })
  const x = extracted(), home = tmp('irori-home-')
  const r = await ps(path.join(x, 'install.ps1'), [...base, '-InviteCode', 'PFX', '-NodeId', 'laptop', '-DisplayName', '筆電', '-HomeDir', home, '-BaseUrl', srv.url])
  assert.equal(r.code, 0, r.out)
  assert.equal(fs.readFileSync(path.join(irori(home), 'node'), 'utf8'), 'W-laptop')
  assert.ok(fs.existsSync(path.join(irori(home), 'W-laptop.key')))
  assert.deepEqual(srv.registers.map(b => b.id), ['laptop', 'W-laptop'])
  await srv.close()
})

test('失敗不留殘骸：邀請碼錯、代號撞名都明確失敗（exit 1），沒有金鑰、沒有 app', { skip: !WIN }, async () => {
  const srv = await fakeRelay({ invites: { OK: {} }, takenIds: ['DUP'] })
  const x = extracted()
  for (const [code, id, pattern] of [['WRONG', 'a1', /邀請碼/], ['OK', 'DUP', /已經有人用/]]) {
    const home = tmp('irori-home-')
    const r = await ps(path.join(x, 'install.ps1'), [...base, '-InviteCode', code, '-NodeId', id, '-DisplayName', 'n', '-HomeDir', home, '-BaseUrl', srv.url])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, pattern)
    assert.match(r.out, /沒有被改動|沒有完成/)
    assert.deepEqual(dirEntries(irori(home)), [], '失敗時不能留下任何檔案')
  }
  await srv.close()
})

test('Node 太舊、或沒有 Node：說明去 nodejs.org 裝 LTS 並結束，不註冊', { skip: !WIN }, async () => {
  const srv = await fakeRelay({ invites: { OK: {} } })
  const x = extracted(), home = tmp('irori-home-')
  const fake = path.join(tmp('irori-fakenode-'), 'oldnode.cmd')
  fs.writeFileSync(fake, '@echo v18.19.0\r\n')
  const old = await ps(path.join(x, 'install.ps1'), [...base, '-InviteCode', 'OK', '-NodeCommand', fake, '-HomeDir', home, '-BaseUrl', srv.url])
  assert.equal(old.code, 1, old.out)
  assert.match(old.out, /太舊/); assert.match(old.out, /nodejs\.org/); assert.match(old.out, /LTS/)
  const none = await ps(path.join(x, 'install.ps1'), [...base, '-InviteCode', 'OK', '-NodeCommand', 'no-such-node-xyz', '-HomeDir', home, '-BaseUrl', srv.url])
  assert.equal(none.code, 1, none.out)
  assert.match(none.out, /還沒有安裝 Node\.js/)
  assert.equal(srv.reqs.length, 0); assert.deepEqual(dirEntries(irori(home)), [])
  await srv.close()
})

test('沒有 Claude Code：提示後照樣安裝；沒解壓縮（缺 app 資料夾）會叫人先解壓縮', { skip: !WIN }, async () => {
  const srv = await fakeRelay({ invites: { OK: {} } })
  const x = extracted(), home = tmp('irori-home-')
  const r = await ps(path.join(x, 'install.ps1'), [...base, '-InviteCode', 'OK', '-NodeId', 'NC1', '-DisplayName', 'n', '-ClaudeCommand', 'no-such-claude-xyz', '-HomeDir', home, '-BaseUrl', srv.url])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /還沒有 Claude Code/)
  assert.ok(fs.existsSync(path.join(irori(home), 'NC1.key')))
  const lone = tmp('irori-lone-')
  fs.copyFileSync(path.join(x, 'install.ps1'), path.join(lone, 'install.ps1'))
  fs.copyFileSync(path.join(x, 'irori-common.ps1'), path.join(lone, 'irori-common.ps1'))
  const nz = await ps(path.join(lone, 'install.ps1'), [...base, '-HomeDir', tmp('irori-home-')])
  assert.equal(nz.code, 1, nz.out); assert.match(nz.out, /解壓縮/)
  await srv.close()
})

test('register.mjs 命令列：邀請碼走環境變數、輸出一行 JSON、不含金鑰', { skip: !WIN }, async () => {
  const srv = await fakeRelay({ invites: { CLI1: {} } })
  const home = tmp('irori-home-')
  const run = (args, env = {}) => new Promise(res => {
    const c = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'relay', 'machine', 'register.mjs'), ...args], { env: { ...process.env, ...env }, windowsHide: true })
    let o = ''; c.stdout.on('data', d => { o += d }); c.on('close', code => res({ code, json: JSON.parse(o.trim()) }))
  })
  const r = await run(['--id', 'CLI-1', '--name', '電腦', '--machine', '電腦', '--url', srv.url, '--home', home], { IRORI_INVITE: 'CLI1' })
  assert.equal(r.code, 0); assert.equal(r.json.ok, true)
  assert.ok(!JSON.stringify(r.json).includes(srv.issued[0]))
  const c = await run(['--check', '--id', 'CLI-1', '--url', srv.url, '--home', home])
  assert.equal(c.json.ok, true)
  const bad = await run(['--id', 'CLI-2', '--name', 'n', '--machine', 'm', '--url', srv.url, '--home', home], { IRORI_INVITE: 'CLI1' })
  assert.equal(bad.code, 1); assert.equal(bad.json.error, 'invalid_invite')
  assert.equal((await run(['--suggest', 'ab cd', '--prefix', 'W-'])).json.id, 'W-ab-cd')
  await srv.close()
})
