// #2203 官網首頁的 Google Play 連結：發版腳本每次都會重寫首頁，連結不能被洗掉。
// 用真的 site/public/index.html，跑真的重寫函式：電腦版（site_files.buildSiteFiles，本機與 CI 共用）、Linux（linux_publish.patchLinuxLinks）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildSiteFiles } from '../tools/release/site_files.mjs'
import { patchLinuxLinks } from '../tools/release/linux_publish.mjs'

const PLAY = 'https://play.google.com/store/apps/details?id=tw.yooliang.asn'
const index = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site', 'public', 'index.html'), 'utf8')
const count = (html, s) => html.split(s).length - 1
const SIG = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQpGSVhFRC1TSUctVEVTVA==\n'
const CHANGELOG = '# 記錄\n\n## 0.9.9（2026-11-30）\n- 測試。\n'
const windows = (html, version = '0.9.9') =>
  buildSiteFiles({ version, sigText: SIG, changelog: CHANGELOG.replaceAll('0.9.9', version), indexHtml: html, pubDate: new Date(0), date: '2026-11-30' }).indexText
const downloadSection = html => html.slice(html.indexOf('<section id="download">'), html.indexOf('</section>', html.indexOf('<section id="download">')))

test('首頁：上方主下載區旁與下載區各有一個 Google Play 連結，文案不寫技術說明', () => {
  assert.equal(count(index, `href="${PLAY}"`), 2)
  assert.ok(downloadSection(index).includes(`<a class="btn" href="${PLAY}">Android：到 Google Play 安裝</a>`))
  assert.match(index, /手機版請到 <a href="[^"]+">Google Play<\/a>/)
  assert.doesNotMatch(index, /內部測試|封閉測試|closed testing/i)
})

test('發版重寫首頁（電腦版）之後，Play 連結仍在、按鈕文字不變', () => {
  const r = windows(index)
  assert.equal(count(r, `href="${PLAY}"`), 2)
  assert.match(downloadSection(r), /Android：到 Google Play 安裝/)
  assert.match(r, /手機版請到/)
})

test('發版重寫首頁（Linux）之後，Play 連結仍在；連續重寫（電腦版→Linux→下一版電腦版→下一版 Linux）也不掉', () => {
  const noLinux = index.replace(/\n\s*<p>Linux（64 位元）：.*<\/p>/, '') // 模擬第一次 Linux 發版前的首頁
  let h = windows(noLinux)
  h = patchLinuxLinks(h, '0.9.9')
  assert.equal(count(h, `href="${PLAY}"`), 2, '第一次加入 Linux 連結後')
  h = windows(h, '0.9.10')
  h = patchLinuxLinks(h, '0.9.10')
  assert.equal(count(h, `href="${PLAY}"`), 2, '下一版重寫後')
  assert.match(h, /ASN_0\.9\.10_amd64\.deb/)
  assert.match(downloadSection(h), /Android：到 Google Play 安裝/)
})
