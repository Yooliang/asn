// #1966 發版腳本叫 asn-cli：PATH 找不到時改用安裝資料夾那支；失敗時 log 要看得出原因
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { makeAsnCli, asnCliFail, installedAsnCli } from '../../../tools/release/asn_cli.mjs'

const enoent = () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync asn-cli ENOENT'), { code: 'ENOENT' }) })
const LOCAL = 'C:/Users/u/AppData/Local'
const ALT = path.join(LOCAL, 'ASN', 'asn-cli.exe')

const fakeSpawn = table => {
  const calls = []
  const spawn = (bin, args) => { calls.push(bin); const f = table[bin]; return f ? f(args) : enoent() }
  return { spawn, calls }
}

test('#1966 PATH 找得到：只叫 asn-cli，不碰安裝資料夾', () => {
  const s = fakeSpawn({ 'asn-cli': () => ({ status: 0, stdout: 'ok', stderr: '' }) })
  const r = makeAsnCli({ spawn: s.spawn, env: { LOCALAPPDATA: LOCAL }, platform: 'win32', exists: () => true })(['send', '--whoami'])
  assert.equal(r.status, 0)
  assert.deepEqual(s.calls, ['asn-cli'])
})

test('#1966 PATH 沒有（ENOENT）：改用 安裝資料夾（%LOCALAPPDATA% 底下 ASN）的 asn-cli.exe，結果照它的', () => {
  const s = fakeSpawn({ [ALT]: args => ({ status: 0, stdout: args.join(' '), stderr: '' }) })
  const r = makeAsnCli({ spawn: s.spawn, env: { LOCALAPPDATA: LOCAL }, platform: 'win32', exists: p => p === ALT })(['send', '--room', 'g1', '--body', 'x'])
  assert.deepEqual(s.calls, ['asn-cli', ALT])
  assert.equal(r.status, 0)
  assert.equal(r.stdout, 'send --room g1 --body x')
})

test('#1966 兩處都沒有：結束碼 1，stderr 寫明找不到 asn-cli 與試過的位置', () => {
  const s = fakeSpawn({})
  const r = makeAsnCli({ spawn: s.spawn, env: { LOCALAPPDATA: LOCAL }, platform: 'win32', exists: () => false })(['send'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /找不到 asn-cli/)
  assert.ok(r.stderr.includes(ALT), r.stderr)
  assert.deepEqual(s.calls, ['asn-cli'], '後備檔不存在就不去執行')
})

test('#1966 非 Windows 或沒有 LOCALAPPDATA：沒有後備，照樣寫明找不到', () => {
  assert.equal(installedAsnCli({ LOCALAPPDATA: LOCAL }, 'linux'), null)
  assert.equal(installedAsnCli({}, 'win32'), null)
  const r = makeAsnCli({ spawn: fakeSpawn({}).spawn, env: {}, platform: 'linux', exists: () => true })(['send'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /找不到 asn-cli/)
})

test('#1966 其他執行錯誤（不是 ENOENT）：不換路徑，訊息帶錯誤代碼', () => {
  const s = fakeSpawn({ 'asn-cli': () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'EACCES' }) }) })
  const r = makeAsnCli({ spawn: s.spawn, env: { LOCALAPPDATA: LOCAL }, platform: 'win32', exists: () => true })(['send'])
  assert.deepEqual(s.calls, ['asn-cli'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /EACCES/)
})

test('#1966 程式有跑但失敗：結束碼與 stderr 原樣帶回；asnCliFail 印出兩者', () => {
  const s = fakeSpawn({ 'asn-cli': () => ({ status: 3, stdout: '', stderr: '群組不存在\n' }) })
  const r = makeAsnCli({ spawn: s.spawn, env: {}, platform: 'win32' })(['send'])
  assert.equal(r.status, 3)
  assert.equal(asnCliFail(r), '結束碼 3：群組不存在')
  assert.equal(asnCliFail({ status: 1, stderr: '' }), '結束碼 1')
  assert.equal(asnCliFail({ status: 1, stderr: 'x'.repeat(500) }).length, '結束碼 1：'.length + 300)
})
