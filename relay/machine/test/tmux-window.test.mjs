// 0.2 H4：沒有桌面的 Linux 用 tmux 開視窗。版本 3.2 以上才開（舊版會把參數交給 sh）；session 名 asn-<名字>、用 =asn-<名字> 精確比對；
// 參數與環境變數直接用 argv 傳、不經 shell；沒有 tmux 就失敗並說明
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { NO_TMUX, TMUX_OLD, attachHint, hasDesktop, parseTmuxVersion, startTmuxWindow, versionOk } from '../tmux-window.mjs'
import { startWindowLinux } from '../launcher.mjs'

function fakeTmux({ version = 'tmux 3.4', existing = [], pid = '4321' } = {}) {
  const calls = []
  const run = async (bin, args) => {
    calls.push([bin, ...args])
    if (args[0] === '-V') return { code: 0, stdout: `${version}\n` }
    if (args[0] === 'has-session') return { code: existing.includes(args[2]) ? 0 : 1, stdout: '' }
    if (args[0] === 'new-session') return { code: 0, stdout: '' }
    if (args[0] === 'display-message') return { code: 0, stdout: `${pid}\n` }
    return { code: 1, stdout: '' }
  }
  return { run, calls }
}
const spec = { command: '/usr/bin/claude', args: ['-n', '小葛', '--append-system-prompt', 'a "b" $(rm -rf ~) `x`; y'], cwd: '/home/u/專案', env: { PATH: '/usr/bin', ASN_PI_NAME: '小葛' }, name: '小葛' }

test('版本：3.2 以上才行；看不懂、太舊都拒絕（不退回字串拼接）', async () => {
  assert.deepEqual(parseTmuxVersion('tmux 3.2a'), [3, 2])
  assert.deepEqual(parseTmuxVersion('tmux next-3.4'), [3, 4])
  for (const v of ['tmux 3.2a', 'tmux 3.3', 'tmux 4.0']) assert.ok(versionOk(parseTmuxVersion(v)), v)
  for (const v of ['tmux 3.1c', 'tmux 2.9', 'tmux master', '']) assert.ok(!versionOk(parseTmuxVersion(v)), v)
  const f = fakeTmux({ version: 'tmux 3.1c' })
  await assert.rejects(startTmuxWindow(spec, { tmux: '/usr/bin/tmux', run: f.run }), new RegExp(TMUX_OLD.slice(0, 10)))
  assert.ok(!f.calls.some(c => c[1] === 'new-session'), '版本太舊：不開')
})

test('開：session 名 asn-<中文名字>、has-session 用 = 精確比對；參數與環境變數用 argv 直接傳（特殊字元原樣，不經 shell）；回 pane 的 pid', async () => {
  const f = fakeTmux()
  const r = await startTmuxWindow(spec, { tmux: '/usr/bin/tmux', run: f.run })
  assert.deepEqual(r, { pid: 4321, tmux: 'asn-小葛' })
  assert.deepEqual(f.calls.find(c => c[1] === 'has-session'), ['/usr/bin/tmux', 'has-session', '-t', '=asn-小葛'])
  const made = f.calls.find(c => c[1] === 'new-session')
  assert.deepEqual(made.slice(1, 7), ['new-session', '-d', '-s', 'asn-小葛', '-c', '/home/u/專案'])
  assert.ok(made.includes('-e') && made.includes('ASN_PI_NAME=小葛') && made.includes('PATH=/usr/bin'), '環境變數用 -e 帶')
  assert.deepEqual(made.slice(-5), ['/usr/bin/claude', '-n', '小葛', '--append-system-prompt', 'a "b" $(rm -rf ~) `x`; y'], '特殊字元原樣當一個參數')
  assert.deepEqual(f.calls.find(c => c[1] === 'display-message'), ['/usr/bin/tmux', 'display-message', '-p', '-t', '=asn-小葛', '#{pane_pid}'])
  assert.equal(attachHint('小葛'), '在那台執行 tmux attach -t asn-小葛 可以看到這個視窗')
})

test('沒有參數時不讓 tmux 交給 sh -c：經 /usr/bin/env 直接 exec（一定是兩個以上的參數）', async () => {
  const f = fakeTmux()
  await startTmuxWindow({ ...spec, command: '/usr/bin/codex', args: [] }, { tmux: '/usr/bin/tmux', run: f.run })
  const made = f.calls.find(c => c[1] === 'new-session')
  assert.deepEqual(made.slice(-2), ['/usr/bin/env', '/usr/bin/codex'])
})

test('同名的 session 已經存在就拒絕（精確比對，不會被 asn-小葛2 之類的前綴騙）', async () => {
  const f = fakeTmux({ existing: ['=asn-小葛'] })
  await assert.rejects(startTmuxWindow(spec, { tmux: '/usr/bin/tmux', run: f.run }), /已經有叫「asn-小葛」/)
  assert.ok(!f.calls.some(c => c[1] === 'new-session'))
  const g = fakeTmux({ existing: ['=asn-小葛2'] })
  assert.equal((await startTmuxWindow(spec, { tmux: '/usr/bin/tmux', run: g.run })).tmux, 'asn-小葛')
})

test('沒有桌面：不開圖形終端、改用 tmux；沒有 tmux 就失敗並說明（不再背景跑沒有 TTY 的程式）', async () => {
  assert.equal(hasDesktop({}), false)
  assert.equal(hasDesktop({ DISPLAY: ':0' }), true)
  assert.equal(hasDesktop({ WAYLAND_DISPLAY: 'wayland-0' }), true)
  await assert.rejects(startWindowLinux(spec, { findTmux: () => null }), new RegExp(NO_TMUX.slice(0, 8)))
  const f = fakeTmux()
  const r = await startWindowLinux(spec, { findTmux: () => '/usr/bin/tmux', run: f.run })
  assert.equal(r.tmux, 'asn-小葛')
})

test('接線：開成 tmux 時，回報的結果寫明怎麼看到這個視窗；檔案是 LF', () => {
  const src = fs.readFileSync(new URL('../launcher.mjs', import.meta.url), 'utf8')
  assert.match(src, /started\?\.tmux \? `\$\{l\.name\} 已開啟；\$\{attachHint\(l\.name\)\}`/)
  for (const f of ['../tmux-window.mjs', '../launcher.mjs']) assert.ok(!fs.readFileSync(new URL(f, import.meta.url), 'utf8').includes('\r\n'), f)
})
