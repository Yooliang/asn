// tools/release/verify_online.mjs（#1892 規格 2.5 第 9 步）：線上核對。注入 fetch 與 sleep，不連網、不真的等。
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { verifyOnline } from '../../../tools/release/verify_online.mjs'
import { skillVersionInfo } from '../../../site/make-skill-version.mjs'

const V = '0.2.37'
const BASE = 'https://site.test'
const exe = Buffer.from('fake-exe-bytes')
const sigText = 'SIGNATURE-TEXT\n'
const md = '---\nversion: 3\n---\n內容\n'
const skill = skillVersionInfo(md)
const URL_ = `https://asnmessenger.web.app/update/ASN_${V}_x64-setup.exe`
const expected = { version: V, notes: '- 改善：甲', signature: sigText.trim(), sigText, exeSha256: crypto.createHash('sha256').update(exe).digest('hex'), exeSize: exe.length, skill }
const good = () => ({
  '/update/latest.json': JSON.stringify({ version: V, notes: '- 改善：甲', pub_date: 'x', platforms: { 'windows-x86_64': { signature: sigText.trim(), url: URL_ } } }),
  [`/update/ASN_${V}_x64-setup.exe`]: exe,
  [`/update/ASN_${V}_x64-setup.exe.sig`]: sigText,
  '/': `<a class="btn" href="${URL_}">下載</a><a href="${URL_}">下載</a>`,
  '/skill/version.json': JSON.stringify(skill),
  '/skill/asn-cloud-agent.md': md,
})
// 假網站：依路徑回內容；記下每個請求的網址（驗證都帶 ?t=）
const site = (routes, seen = []) => async url => {
  seen.push(url)
  const u = new URL(url)
  const body = routes[u.pathname]
  if (body === undefined) return { ok: false, status: 404 }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
  return { ok: true, status: 200, text: async () => buf.toString('utf8'), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }
}
const run = (routes, extra = {}) => {
  const sleeps = []
  return verifyOnline({ expected, base: BASE, fetchFn: site(routes, extra.seen), sleep: async ms => { sleeps.push(ms) }, now: () => 111, ...extra }).then(r => ({ ...r, sleeps }))
}

test('全部一致：第一次就過，不睡覺，每個請求都帶 ?t=', async () => {
  const seen = []
  const r = await run(good(), { seen })
  assert.deepEqual([r.ok, r.attempts, r.sleeps], [true, 1, []])
  assert.equal(seen.length, 6)
  assert.ok(seen.every(u => u.includes('t=111')), seen.join('\n'))
})

const bad = {
  'latest.json 版本舊': r => { r['/update/latest.json'] = r['/update/latest.json'].replace(V, '0.2.36') },
  'notes 不同': r => { r['/update/latest.json'] = r['/update/latest.json'].replace('甲', '乙') },
  'signature 不同': r => { r['/update/latest.json'] = r['/update/latest.json'].replace('SIGNATURE-TEXT', 'OTHER') },
  'url 不同': r => { r['/update/latest.json'] = r['/update/latest.json'].replace(URL_, `${URL_}x`) },
  '安裝檔大小不同': r => { r[`/update/ASN_${V}_x64-setup.exe`] = Buffer.from('fake-exe-bytes!') },
  '安裝檔同大小不同內容': r => { r[`/update/ASN_${V}_x64-setup.exe`] = Buffer.from('fake-exe-bytez') },
  '.sig 不同': r => { r[`/update/ASN_${V}_x64-setup.exe.sig`] = 'OTHER' },
  '首頁連結指向舊版': r => { r['/'] = r['/'].replace(V, '0.2.36') },
  '首頁只有一個連結對': r => { r['/'] += `<a href="https://asnmessenger.web.app/update/ASN_0.2.30_x64-setup.exe">舊</a>` },
  '首頁沒有連結': r => { r['/'] = '<p>x</p>' },
  'skill version.json 不同': r => { r['/skill/version.json'] = JSON.stringify({ ...skill, sha256: 'a'.repeat(64) }) },
  '技能說明檔與 version.json 雜湊不合': r => { r['/skill/asn-cloud-agent.md'] = `${md}多一行\n` },
  '安裝檔 404': r => { delete r[`/update/ASN_${V}_x64-setup.exe`] },
}
for (const [name, mutate] of Object.entries(bad)) {
  test(`不一致必擋：${name}`, async () => {
    const r = good(); mutate(r)
    const out = await run(r)
    assert.equal(out.ok, false)
    assert.ok(out.problems.length >= 1)
  })
}

test('重試：前兩次是舊的、第三次追上就過；睡 15 秒', async () => {
  let n = 0
  const fresh = good()
  const stale = good(); stale['/update/latest.json'] = stale['/update/latest.json'].replace(V, '0.2.36')
  const fetchFn = async (url) => {
    const u = new URL(url)
    if (u.pathname === '/update/latest.json') n++
    return site(n < 3 ? stale : fresh)(url)
  }
  const sleeps = []
  const r = await verifyOnline({ expected, base: BASE, fetchFn, sleep: async ms => { sleeps.push(ms) }, now: () => 1 })
  assert.deepEqual([r.ok, r.attempts, sleeps], [true, 3, [15000, 15000]])
})

test('一直不一致：試 10 次、睡 9 次（最後一次後不睡）、回最後一輪的問題', async () => {
  const r = good(); bad['安裝檔 404'](r)
  const out = await run(r)
  assert.deepEqual([out.ok, out.attempts, out.sleeps.length], [false, 10, 9])
  assert.ok(out.sleeps.every(ms => ms === 15000))
  assert.match(out.problems.join('\n'), /404/)
})

test('連線例外不拋出：算這一輪失敗', async () => {
  const out = await verifyOnline({ expected, base: BASE, fetchFn: async () => { throw new Error('boom') }, sleep: async () => {}, now: () => 1, attempts: 2 })
  assert.equal(out.ok, false)
  assert.match(out.problems[0], /連不上/)
})
