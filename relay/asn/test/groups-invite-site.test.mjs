// 邀請連結的落地：官網 /i/<碼> 頁（沒裝 ASN 時顯示下載與「打開 ASN」）、Android App Links（assetlinks.json、AndroidManifest）、asn:// 的設定。
// 守門：頁面沒有行內程式（CSP 只放行同源腳本）、邀請碼只在本頁用不外送、不被索引、不送 referrer。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n')
const fb = JSON.parse(read('site', 'firebase.json'))

test('firebase.json：/i/** 改寫到邀請頁、assetlinks 改寫到 wk/；/i/** 的標頭放行同源腳本、不送 referrer、不快取', () => {
  const rw = Object.fromEntries(fb.hosting.rewrites.map(r => [r.source, r.destination]))
  assert.equal(rw['/i/**'], '/i/index.html'); assert.equal(rw['/.well-known/assetlinks.json'], '/wk/assetlinks.json')
  const rules = fb.hosting.headers
  const base = rules.findIndex(r => r.source === '**'), inv = rules.findIndex(r => r.source === '/i/**')
  assert.ok(base >= 0 && inv > base, '/i/** 的規則要排在 ** 之後才會蓋過去')
  const h = k => Object.fromEntries(rules[inv].headers.map(x => [x.key, x.value]))[k]
  assert.match(h('Content-Security-Policy'), /script-src 'self'/); assert.doesNotMatch(h('Content-Security-Policy'), /unsafe-inline|unsafe-eval/)
  assert.match(h('Content-Security-Policy'), /connect-src 'none'/, '邀請碼不能被頁面送出去'); assert.match(h('Content-Security-Policy'), /frame-ancestors 'none'/)
  assert.equal(h('Referrer-Policy'), 'no-referrer'); assert.equal(h('Cache-Control'), 'no-store')
  assert.ok(fb.hosting.ignore.includes('**/.*'), '仍然不公開隱藏檔；assetlinks 走改寫')
})

test('邀請頁：只有同源腳本、不被索引；有「打開 ASN」、複製邀請碼、下載連結與一次性 24 小時說明', () => {
  const html = read('site', 'public', 'i', 'index.html')
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/, '不能有行內程式'); assert.match(html, /<script src="\/i\/i\.js">/)
  assert.match(html, /name="robots" content="noindex"/); assert.match(html, /name="referrer" content="no-referrer"/)
  for (const s of ['打開 ASN', '複製邀請碼', 'href="/#download"', '一次性、24 小時內有效']) assert.ok(html.includes(s), s)
  assert.doesNotMatch(html, /https?:\/\/(?!asnmessenger\.web\.app)/, '不引用外部資源')
})

function runPage(pathname) {
  const els = {}
  const el = () => ({ hidden: true, textContent: '', href: '', listeners: {}, addEventListener(e, f) { this.listeners[e] = f } })
  for (const id of ['bad', 'code', 'code-row', 'open', 'copy']) els[id] = el()
  const ctx = { location: { pathname }, document: { getElementById: id => els[id] }, navigator: {}, window: { prompt() {} } }
  vm.runInNewContext(read('site', 'public', 'i', 'i.js'), ctx)
  return els
}
const CODE = 'AbCdEf0123456789_-xyz'
test('邀請頁腳本：從網址取碼，組出 asn://invite/<碼>；網址不對只顯示提示、不組連結', () => {
  const ok = runPage(`/i/${CODE}`)
  assert.equal(ok.open.href, `asn://invite/${CODE}`); assert.equal(ok.code.textContent, CODE); assert.equal(ok.open.hidden, false); assert.equal(ok.copy.hidden, false); assert.equal(ok.bad.hidden, true)
  assert.equal(runPage(`/i/${CODE}/`).open.href, `asn://invite/${CODE}`)
  for (const bad of ['/i/', '/i/短', `/i/${CODE}/../x`, `/i/${CODE};rm`, '/x/' + CODE, `/i/${'a'.repeat(65)}`]) {
    const r = runPage(bad)
    assert.equal(r.bad.hidden, false, bad); assert.equal(r.open.href, '', bad); assert.equal(r.open.hidden, true, bad)
  }
})

test('Android App Links：manifest 有 autoVerify 的 https 邀請網址；assetlinks 是這個 App 的套件名；tauri 設定的外掛與電腦的 asn:// 一致', () => {
  const m = read('relay', 'asn', 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'AndroidManifest.xml')
  assert.match(m, /<intent-filter android:autoVerify="true">[\s\S]*?android:scheme="https" android:host="asnmessenger\.web\.app" android:pathPrefix="\/i\/"[\s\S]*?<\/intent-filter>/)
  assert.match(m, /android:launchMode="singleTask"/, '已開著時點連結要回到同一個畫面')
  const al = JSON.parse(read('site', 'public', 'wk', 'assetlinks.json'))
  assert.equal(al[0].target.package_name, 'tw.yooliang.asn'); assert.deepEqual(al[0].relation, ['delegate_permission/common.handle_all_urls'])
  const conf = JSON.parse(read('relay', 'asn', 'src-tauri', 'tauri.conf.json')).plugins['deep-link']
  assert.deepEqual(conf.desktop.schemes, ['asn']); assert.equal(conf.mobile[0].host, 'asnmessenger.web.app'); assert.deepEqual(conf.mobile[0].pathPrefix, ['/i/'])
  const rs = read('relay', 'asn', 'src-tauri', 'src', 'invite_link.rs')
  assert.match(rs, /asn:\/\/invite\//); assert.match(rs, /https:\/\/asnmessenger\.web\.app\/i\//)
})