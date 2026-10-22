import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { vendorIconSvg } from '../ui/lib/vendor-icons.mjs'

const DOC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/ASN-VENDOR-ICONS.md')

test('廠商圖示：gemini 與 grok 不同、皆為 SVG', () => {
  const g = vendorIconSvg('gemini')
  const k = vendorIconSvg('grok')
  assert.notEqual(g, k)
  assert.match(g, /^<svg/)
  assert.match(k, /^<svg/)
})

test('依廠商分頁：ASN 自己那一格用小機器人（logo.svg），不是「其他」的三個點', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../ui/list.html'), 'utf8')
  const asn = html.indexOf(`d.vendorKey === 'asn'" src="img/logo.svg"`)
  const generic = html.indexOf('v-html="vendorIcon(d.vendorKey)"')
  assert.ok(asn > 0, '要有 ASN 專用的機器人分支')
  assert.ok(asn < generic, 'ASN 分支要排在一般廠商圖示之前，否則會先落到三個點')
})

test('授權文件存在且提到 CC0', () => {
  const t = fs.readFileSync(DOC, 'utf8')
  assert.match(t, /CC0/)
  assert.match(t, /vendor-icons/)
})
