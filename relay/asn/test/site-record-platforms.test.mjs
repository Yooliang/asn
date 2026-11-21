// #1996 三平台發完後補官網版本紀錄的平台：gh 與 asn-cli 都用注入的，不碰真的後台
import test from 'node:test'
import assert from 'node:assert/strict'
import { planPlatforms, mergePlatforms, gatherFacts, run } from '../../../tools/release/site_record_platforms.mjs'

const V = '0.2.50'
const ALL = [`ASN_${V}_x64-setup.exe`, `ASN_${V}_x64-setup.exe.sig`, `ASN_${V}_amd64.AppImage`, `ASN_${V}_amd64.AppImage.sig`, `ASN_${V}_amd64.deb`]

// 假 gh：release＝null 表示找不到；runs＝null 表示沒打手機標籤
const fakeGh = ({ release = { isDraft: false, assets: ALL }, upload = 'success' } = {}) => {
  const calls = []
  const gh = args => {
    calls.push(args)
    if (args[0] === 'release') {
      if (!release) throw new Error('release not found')
      return JSON.stringify({ isDraft: release.isDraft, assets: release.assets.map(name => ({ name })) })
    }
    if (args[1].includes('/actions/runs?branch=')) {
      return JSON.stringify({ workflow_runs: upload === 'none' ? [] : [{ id: 7, run_number: 3, run_attempt: 2, head_branch: `android-v${V}` }, { id: 6, run_number: 2, head_branch: `android-v${V}` }] })
    }
    if (args[1].includes('/runs/7/attempts/2/jobs')) return JSON.stringify({ jobs: [{ name: 'build', conclusion: 'success' }, ...(upload === 'nojob' ? [] : [{ name: 'android-upload', conclusion: upload }])] })
    throw new Error(`沒預期的 gh 呼叫：${args.join(' ')}`)
  }
  return { gh, calls }
}
const harness = ({ current = ['官網'], ghOpts, argv = [V] } = {}) => {
  const out = []
  const writes = []
  const f = fakeGh(ghOpts)
  const asnCli = async a => { writes.push(a); return { status: 0, stdout: '', stderr: '' } }
  const readPlatforms = async () => current
  return { out, writes, f, go: () => run({ argv, gh: f.gh, asnCli, readPlatforms, log: s => out.push(s) }) }
}
const plan = ghOpts => planPlatforms(gatherFacts(V, fakeGh(ghOpts).gh))

test('三個都發：官網、Linux、Play', () => {
  assert.deepEqual(plan().platforms, ['官網', 'Linux', 'Play'])
})
test('只發電腦版加 Linux：沒打手機標籤，Play 不列並寫明原因', () => {
  const p = plan({ ghOpts: undefined, upload: 'none' })
  assert.deepEqual(p.platforms, ['官網', 'Linux'])
  assert.match(p.rows.find(r => r.platform === 'Play').reason, /沒打手機標籤/)
})
test('只發手機：Release 不存在，只有 Play', () => {
  const p = plan({ release: null })
  assert.deepEqual(p.platforms, ['Play'])
  assert.match(p.rows[0].reason, /找不到/)
})
test('Linux 附件不齊：Linux 不列', () => {
  const p = plan({ release: { isDraft: false, assets: ALL.filter(n => !n.endsWith('.deb')) } })
  assert.deepEqual(p.platforms, ['官網', 'Play'])
  assert.match(p.rows[1].reason, /缺 deb/)
})
test('草稿 Release 或沒有安裝檔：官網不列', () => {
  assert.equal(plan({ release: { isDraft: true, assets: ALL } }).platforms.includes('官網'), false)
  assert.equal(plan({ release: { isDraft: false, assets: ALL.filter(n => !n.includes('x64-setup')) } }).platforms.includes('官網'), false)
})
test('手機 android-upload 失敗：Play 不列並寫明結論', () => {
  const p = plan({ upload: 'failure' })
  assert.deepEqual(p.platforms, ['官網', 'Linux'])
  assert.match(p.rows[2].reason, /failure/)
})
test('三個都沒發成：不寫入、結束碼 1', async () => {
  const h = harness({ ghOpts: { release: null, upload: 'none' } })
  assert.equal(await h.go(), 1)
  assert.equal(h.writes.length, 0)
  assert.ok(h.out.some(l => l.includes('都沒發成')))
})
test('補齊：呼叫 asn-cli 一次，只帶版本與平台（聯集，依序）', async () => {
  const h = harness({ current: ['官網', 'Play'] })
  assert.equal(await h.go(), 0)
  assert.deepEqual(h.writes, [['site', 'release', '--version', V, '--platform', '官網', '--platform', 'Linux', '--platform', 'Play']])
})
test('已是最新：不重寫', async () => {
  const h = harness({ current: ['官網', 'Linux', 'Play'] })
  assert.equal(await h.go(), 0)
  assert.equal(h.writes.length, 0)
  assert.ok(h.out.some(l => l.includes('已是最新')))
})
test('--dry-run：不呼叫 asn-cli', async () => {
  const h = harness({ argv: [V, '--dry-run'] })
  assert.equal(await h.go(), 0)
  assert.equal(h.writes.length, 0)
  assert.ok(h.out.some(l => l.includes('--dry-run')))
})
test('紀錄不存在：停下不寫入；版號格式錯：用法 2', async () => {
  const h = harness({ current: null })
  h.go = () => run({ argv: [V], gh: h.f.gh, asnCli: async a => { h.writes.push(a); return { status: 0 } }, readPlatforms: async () => null, log: s => h.out.push(s) })
  assert.equal(await h.go(), 1)
  assert.equal(h.writes.length, 0)
  assert.equal(await harness({ argv: ['abc'] }).go(), 2)
})
test('asn-cli 失敗：結束碼 1，原文不進一般輸出', async () => {
  const out = []
  const c = await run({ argv: [V], gh: fakeGh().gh, asnCli: async () => ({ status: 3, stderr: '祕密原文' }), readPlatforms: async () => ['官網'], log: s => out.push(s) })
  assert.equal(c, 1)
  assert.ok(!out.join('\n').includes('祕密原文'))
})
test('mergePlatforms 保留原有的其他名稱', () => {
  assert.deepEqual(mergePlatforms(['官網', '別的'], ['Linux']), ['官網', 'Linux', '別的'])
})
