// 官網下載區「Edge 擋下載時怎麼辦」（0.2.28）：三個步驟、示意圖存在、用白話不寫技術名詞
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site', 'public')
const html = readFileSync(path.join(root, 'index.html'), 'utf8')
const section = html.slice(html.indexOf('<section id="download">'), html.indexOf('</section>', html.indexOf('<section id="download">')))
const keep = section.slice(section.indexOf('id="edge-keep"'))

test('下載區有 Edge 擋下載的說明：按「…」→「保留」→「仍要保留」', () => {
  assert.ok(section.includes('id="edge-keep"'), '下載區裡要有這段說明')
  const steps = [...keep.matchAll(/<li>([^<]+)<\/li>/g)].map(m => m[1])
  assert.equal(steps.length, 3)
  assert.match(steps[0], /按「…」/)
  assert.match(steps[1], /選「保留」/)
  assert.match(steps[2], /按「仍要保留」/)
  assert.match(keep, /不常下載/)
})

test('示意圖存在、有替代文字，說明與圖都不寫技術名詞', () => {
  assert.ok(existsSync(path.join(root, 'img', 'edge-keep.svg')))
  assert.match(keep, /<img src="\/img\/edge-keep\.svg"[^>]* alt="示意圖：[^"]+"/)
  const svg = readFileSync(path.join(root, 'img', 'edge-keep.svg'), 'utf8')
  for (const t of [keep, svg]) assert.doesNotMatch(t, /SmartScreen|簽章|簽名|憑證|signature|certificate/i)
  // 示意圖只能是靜態圖：不帶程式、不連外
  assert.doesNotMatch(svg, /<script|xlink:href|<a\s|<image|<foreignObject/i)
})
