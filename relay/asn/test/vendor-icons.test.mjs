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

test('授權文件存在且提到 CC0', () => {
  const t = fs.readFileSync(DOC, 'utf8')
  assert.match(t, /CC0/)
  assert.match(t, /vendor-icons/)
})
