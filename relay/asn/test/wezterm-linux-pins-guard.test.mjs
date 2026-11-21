// #1258 ① 發版前守門：驗 pins 的 Linux 自建包（雜湊、大小、建置來源證明、成員）。
// 用真的 tar／xz 格式（測試裡自己打小包），gh 驗證用注入的假函式，不連網。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  EXPECTED_MEMBERS, planFromPins, parseTar, memberProblems, bytesProblems, sha256Hex, verifyLinuxPins, attestationArgs,
} from '../../../tools/release/wezterm_linux_pins.mjs'
import { main, realIo } from '../../../tools/release/verify_wezterm_linux_pins.mjs'

/** 打一個 ustar tar（未壓縮）。members: [{name, type='0', data='', link=''}] */
function makeTar(members) {
  const blocks = []
  for (const m of members) {
    const data = Buffer.from(m.data ?? '')
    const h = Buffer.alloc(512)
    h.write(m.name, 0, 'utf8')
    h.write('0000755\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116)
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
    h.write('00000000000\0', 136)
    h.write('        ', 148)
    h[156] = (m.type ?? '0').charCodeAt(0)
    if (m.link) h.write(m.link, 157)
    h.write('ustar\0' + '00', 257)
    let sum = 0; for (const b of h) sum += b
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}
const good = () => EXPECTED_MEMBERS.map(name => ({ name, data: `內容 ${name}` }))
const xz = tar => {
  const r = spawnSync('xz', ['-zc'], { input: tar, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.status, 0, '測試環境要有 xz 指令')
  return r.stdout
}

const TAG = 'wezterm-20240203-110809-5046fc22-asn.3'
const pinsFor = (files, extra = {}) => {
  const linux = {}
  for (const [key, tarball, buf] of files) linux[key] = { tarball, sha256: sha256Hex(buf), size: buf.length }
  return {
    version: '20240203-110809-5046fc22',
    windows_bundle: { repo: 'Yooliang/asn', tag: TAG, signer_workflow: 'Yooliang/asn/.github/workflows/wezterm-build.yml' },
    linux, ...extra,
  }
}
const asnName = d => `wezterm-20240203-110809-5046fc22-asn.3.${d}.tar.xz`
const okAttest = async () => ({ ok: true })

/** 用記憶體裡的檔跑 verifyLinuxPins */
async function run(pins, files, { attest = okAttest } = {}) {
  const plan = planFromPins(pins)
  assert.equal(plan.mode, 'self-built', plan.problems.join(';'))
  const byName = new Map(files.map(([, n, b]) => [n, b]))
  return verifyLinuxPins(plan, {
    getFile: async e => byName.get(e.tarball),
    fileOnDisk: e => e.tarball,
    attest,
    tarMembers: async buf => parseTar(buf),   // 這裡的「buf」直接是 tar（不壓縮），壓縮那段由 realIo 測試覆蓋
  })
}
const one = (tar) => [['ubuntu-22.04', asnName('Ubuntu22.04'), tar]]

test('#1258 全部正確：四個一般檔、雜湊大小對、證明過 → 通過', async () => {
  const f = one(makeTar(good()))
  const r = await run(pinsFor(f), f)
  assert.equal(r.ok, true)
  assert.deepEqual(r.results[0].problems, [])
})

test('#1258 雜湊差一位 → 紅，並點名是雜湊', async () => {
  const f = one(makeTar(good()))
  const pins = pinsFor(f)
  const h = pins.linux['ubuntu-22.04'].sha256
  pins.linux['ubuntu-22.04'].sha256 = h.slice(0, -1) + (h.endsWith('0') ? '1' : '0')
  const r = await run(pins, f)
  assert.equal(r.ok, false)
  assert.match(r.results[0].problems.join('\n'), /雜湊不符/)
})

test('#1258 大小不符 → 紅，並點名是大小', async () => {
  const f = one(makeTar(good()))
  const pins = pinsFor(f)
  pins.linux['ubuntu-22.04'].size += 1
  const r = await run(pins, f)
  assert.equal(r.ok, false)
  assert.match(r.results[0].problems.join('\n'), /大小不符/)
})

test('#1258 成員多一個 → 紅', async () => {
  const f = one(makeTar([...good(), { name: 'extra', data: 'x' }]))
  const r = await run(pinsFor(f), f)
  assert.equal(r.ok, false)
  assert.match(r.results[0].problems.join('\n'), /多出不該有的成員「extra」/)
})

test('#1258 成員少一個 → 紅', async () => {
  const f = one(makeTar(good().filter(m => m.name !== 'SOURCE.txt')))
  const r = await run(pinsFor(f), f)
  assert.equal(r.ok, false)
  assert.match(r.results[0].problems.join('\n'), /缺少成員「SOURCE.txt」/)
})

test('#1258 成員是符號連結（名字對、型別不對）→ 紅', async () => {
  const m = good().map(x => x.name === 'wezterm-mux-server' ? { name: x.name, type: '2', link: '/bin/sh' } : x)
  const f = one(makeTar(m))
  const r = await run(pinsFor(f), f)
  assert.equal(r.ok, false)
  assert.match(r.results[0].problems.join('\n'), /「wezterm-mux-server」不是一般檔（符號連結）/)
})

test('#1258 成員有目錄穿越／絕對路徑／重複 → 紅', () => {
  assert.match(memberProblems(parseTar(makeTar([...good(), { name: '../evil' }])).entries).join('\n'), /跑出解壓資料夾/)
  assert.match(memberProblems(parseTar(makeTar([...good(), { name: '/etc/passwd' }])).entries).join('\n'), /跑出解壓資料夾/)
  assert.match(memberProblems(parseTar(makeTar([...good(), { name: 'wezterm' }])).entries).join('\n'), /重複出現 2 次/)
  assert.match(memberProblems(parseTar(makeTar([...good(), { name: 'usr', type: '5' }])).entries).join('\n'), /資料夾/)
})

test('#1258 建置來源證明驗不過（注入假函式）→ 紅，且訊息帶 gh 的原因', async () => {
  const f = one(makeTar(good()))
  const r = await run(pinsFor(f), f, { attest: async () => ({ ok: false, detail: 'no attestations found' }) })
  assert.equal(r.ok, false)
  assert.match(r.results[0].problems.join('\n'), /建置來源證明：no attestations found/)
})

test('#1258 證明用的規則與 Windows 一致：同 repo、同 workflow、source-ref 是 main', () => {
  const f = one(makeTar(good()))
  const plan = planFromPins(pinsFor(f))
  assert.deepEqual(attestationArgs('x.tar.xz', plan), [
    'attestation', 'verify', 'x.tar.xz', '--repo', 'Yooliang/asn',
    '--signer-workflow', 'Yooliang/asn/.github/workflows/wezterm-build.yml', '--source-ref', 'refs/heads/main',
  ])
})

test('#1258 多包時每一包都驗，只壞一包整體就紅並指出是哪一包', async () => {
  const a = makeTar(good()), b = makeTar([...good(), { name: 'extra' }])
  const f = [['ubuntu-22.04', asnName('Ubuntu22.04'), a], ['debian-12', asnName('Debian12'), b]]
  const r = await run(pinsFor(f), f)
  assert.equal(r.ok, false)
  assert.deepEqual(r.results.map(x => x.problems.length > 0), [false, true])
  assert.equal(r.results[1].key, 'debian-12')
})

test('#1258 空清單 → 失敗，不能當通過', async () => {
  const pins = pinsFor([])
  assert.equal(planFromPins(pins).mode, 'empty')
  assert.equal(planFromPins({ ...pins, linux: undefined }).mode, 'empty')
  const errs = []
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinsguard-'))
  const p = path.join(tmp, 'pins.json'); fs.writeFileSync(p, JSON.stringify(pins))
  const code = await main(['--pins', p], { log: () => {}, errLog: m => errs.push(m) })
  assert.equal(code, 1)
  assert.match(errs.join('\n'), /空清單/)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('#1258 pins 欄位不合、混用上游與自建、與 windows_bundle 對不上 → invalid', () => {
  const f = one(makeTar(good()))
  const base = pinsFor(f)
  assert.equal(planFromPins({ ...base, linux: { a: { tarball: 'x', sha256: 'zz', size: 1 } } }).mode, 'invalid')
  const mixed = pinsFor([...f, ['debian-12', 'wezterm-20240203-110809-5046fc22.Debian12.tar.xz', Buffer.from('u')]])
  assert.equal(planFromPins(mixed).mode, 'invalid')
  assert.equal(planFromPins(pinsFor(f, { linux_bundle: { repo: 'Yooliang/asn', tag: 'wezterm-20240203-110809-5046fc22-asn.2', signer_workflow: base.windows_bundle.signer_workflow } })).mode, 'invalid')
  assert.equal(planFromPins(pinsFor(f, { linux_bundle: { repo: 'evil/asn', tag: TAG, signer_workflow: base.windows_bundle.signer_workflow } })).mode, 'invalid')
  assert.equal(planFromPins({ ...base, windows_bundle: undefined }).mode, 'invalid')
})

test('#1258 pins 還是上游版：明確印出略過並以 0 結束；加 --expect-self-built 就失敗', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinsguard-'))
  const p = path.join(tmp, 'pins.json')
  fs.writeFileSync(p, JSON.stringify(pinsFor([['ubuntu-22.04', 'wezterm-20240203-110809-5046fc22.Ubuntu22.04.tar.xz', Buffer.from('u')]])))
  const out = [], errs = []
  assert.equal(await main(['--pins', p], { log: m => out.push(m), errLog: m => errs.push(m) }), 0)
  assert.match(out.join('\n'), /Linux 仍為上游版，略過自建驗證/)
  assert.equal(await main(['--pins', p, '--expect-self-built'], { log: m => out.push(m), errLog: m => errs.push(m) }), 1)
  assert.match(errs.join('\n'), /必須是自建版/)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('#1258 真的 tar.xz 走完整流程（xz 解壓＋tar 解析＋大小雜湊＋假 gh）：綠；換成多一個成員的包：紅', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinsguard-'))
  try {
    const goodXz = xz(makeTar(good()))
    const badXz = xz(makeTar([...good(), { name: 'usr/bin/wezterm' }]))
    const name = asnName('Ubuntu22.04')
    const calls = []
    const fakeGh = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' } }
    const mk = (xzBuf, pinBuf) => {
      const dl = fs.mkdtempSync(path.join(tmp, 'dl-'))
      fs.writeFileSync(path.join(dl, name), xzBuf)
      const p = path.join(tmp, `pins-${Math.random().toString(36).slice(2)}.json`)
      fs.writeFileSync(p, JSON.stringify(pinsFor([['ubuntu-22.04', name, pinBuf]])))
      return { dl, p }
    }
    const out = [], errs = []
    const io = (plan, dl) => realIo(plan, dl, fakeGh)
    const g = mk(goodXz, goodXz)
    assert.equal(await main(['--pins', g.p, '--dl-dir', g.dl], { log: m => out.push(m), errLog: m => errs.push(m), makeIo: io }), 0, errs.join('\n'))
    assert.match(out.join('\n'), /全部 1 包通過/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'gh')
    const b = mk(badXz, badXz)
    assert.equal(await main(['--pins', b.p, '--dl-dir', b.dl], { log: () => {}, errLog: m => errs.push(m), makeIo: io }), 1)
    assert.match(errs.join('\n'), /多出不該有的成員「usr\/bin\/wezterm」/)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('#1258 壞掉的 tar（檢查碼錯、被截斷）→ 紅，不丟例外', async () => {
  const t = makeTar(good())
  const broken = Buffer.from(t); broken[0] ^= 0xff
  assert.match(parseTar(broken).error, /檢查碼/)
  assert.match(parseTar(t.subarray(0, 700)).error ?? '', /截斷|結尾/)
  const f = one(broken)
  const r = await run(pinsFor(f), f)
  assert.equal(r.ok, false)
})

test('#1258 bytesProblems：先比大小再比雜湊', () => {
  const b = Buffer.from('abc')
  assert.deepEqual(bytesProblems(b, { size: 3, sha256: sha256Hex(b) }), [])
  assert.equal(bytesProblems(b, { size: 4, sha256: sha256Hex(b) }).length, 1)
})
