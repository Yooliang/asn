// tools/release/site_verify_online.mjs（#1947 ④）：官網部署後的線上核對。假 fetch、假 sleep，不連網、不真的等。
import test from 'node:test'
import assert from 'node:assert/strict'
import { verifySiteOnline, main } from '../../../tools/release/site_verify_online.mjs'

const BASE = 'https://site.test'
const EXE = 'https://asnmessenger.web.app/update/ASN_0.2.45_x64-setup.exe'
const DEB = 'https://asnmessenger.web.app/update/ASN_0.2.45_amd64.deb'
const latest = { version: '0.2.45', notes: 'n', platforms: { 'windows-x86_64': { signature: 's', url: EXE } } }
const home = `<a href="/#download">x</a><a href="${EXE}">a</a><a href="${EXE}">b</a><a href="${DEB}">c</a>`

/** state.latest／state.status 可在重試之間被改；calls 記錄每次請求 */
const mk = (state = {}) => {
  const calls = []
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method, headers: opts.headers })
    const u = new URL(url)
    const reply = (status, body = '') => ({ ok: status >= 200 && status < 300, status, text: async () => body, body: null })
    if (url.startsWith(BASE)) {
      if (u.pathname === '/update/latest.json') return reply(200, JSON.stringify(state.latest ?? latest))
      if (u.pathname === '/') return reply(200, state.home ?? home)
    }
    if (u.pathname.startsWith('/update/ASN_')) return reply(state.installerStatus?.(url) ?? 200)
    return reply(404)
  }
  return { fetchFn, calls }
}
const run = (state, extra = {}) => { const m = mk(state); return verifySiteOnline({ expectedLatest: latest, base: BASE, fetchFn: m.fetchFn, sleep: async () => {}, now: () => 7, attempts: 3, ...extra }).then(r => ({ ...r, calls: m.calls })) }

test('一致：通過、第 1 次就過；每次請求都帶 ?t= 與 no-cache；安裝檔連結去重後各 HEAD 一次', async () => {
  const r = await run()
  assert.equal(r.ok, true)
  assert.equal(r.attempts, 1)
  assert.ok(r.calls.every(c => c.url.includes('t=7') && c.headers['cache-control'] === 'no-cache'))
  const heads = r.calls.filter(c => c.method === 'HEAD').map(c => c.url)
  assert.equal(heads.length, 2)
})

test('latest.json 不一致：重試用完後失敗，訊息指出版本', async () => {
  const r = await run({ latest: { ...latest, version: '0.2.44' } })
  assert.equal(r.ok, false)
  assert.equal(r.attempts, 3)
  assert.match(r.problems.join('\n'), /latest\.json 與 repo 的不同.*0\.2\.44/)
})

test('只差一個欄位（簽章）也算不一致', async () => {
  const r = await run({ latest: { ...latest, platforms: { 'windows-x86_64': { signature: 'other', url: EXE } } } })
  assert.equal(r.ok, false)
})

test('延遲後才一致：第 3 次重試成功，且有等待', async () => {
  const m = mk({ latest: { ...latest, version: 'old' } })
  let sleeps = 0
  const r = await verifySiteOnline({
    expectedLatest: latest, base: BASE, attempts: 5, sleep: async () => { sleeps++; },
    fetchFn: async (url, o) => {
      // 第 3 輪起 CDN 才更新
      if (sleeps >= 2) return mk({}).fetchFn(url, o)
      return m.fetchFn(url, o)
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.attempts, 3)
  assert.equal(sleeps, 2)
})

test('安裝檔連結轉址後不是 200：失敗', async () => {
  const r = await run({ installerStatus: url => (url.includes('.deb') ? 404 : 200) })
  assert.equal(r.ok, false)
  assert.match(r.problems.join('\n'), /amd64\.deb.*404/)
})

test('首頁找不到安裝檔連結：失敗；連不上：失敗', async () => {
  assert.equal((await run({ home: '<a href="/#download">x</a>' })).ok, false)
  const r = await verifySiteOnline({ expectedLatest: latest, base: BASE, attempts: 2, sleep: async () => {}, fetchFn: async () => { throw new Error('boom') } })
  assert.equal(r.ok, false)
  assert.match(r.problems.join('\n'), /連不上/)
})

test('CLI：通過回 0、不一致回 1、讀不到本機檔回 1', async () => {
  const logs = []
  const base = { log: m => logs.push(m), sleep: async () => {} }
  assert.equal(await main(['--base', BASE, '--attempts', '1'], { ...base, readFile: () => JSON.stringify(latest), fetchFn: mk().fetchFn }), 0)
  assert.equal(await main(['--base', BASE, '--attempts', '1'], { ...base, readFile: () => JSON.stringify({ ...latest, version: 'x' }), fetchFn: mk().fetchFn }), 1)
  assert.equal(await main([], { ...base, readFile: () => { throw new Error('nofile') }, fetchFn: mk().fetchFn }), 1)
})
