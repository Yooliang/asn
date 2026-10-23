// 手機版「使用指引」：篇目沿用電腦版（不複製內容）、每篇有手機適用標示、導覽、頁面不用 v-html。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GUIDES, GUIDE_KEYS } from '../ui/lib/guides.mjs'
import { GUIDE_FIT, guideNav, phoneGuide, phoneGuideList } from '../ui/lib/mobile-guides.mjs'
import { normalizeNav } from '../ui/lib/mobile.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n')

test('篇目：跟電腦版同一份（順序、標題、副標），每一篇都有手機適用標示', () => {
  const list = phoneGuideList()
  assert.deepEqual(list.map(g => g.key), GUIDE_KEYS)
  assert.deepEqual(list.map(g => g.title), GUIDES.map(g => g.title))
  assert.deepEqual(Object.keys(GUIDE_FIT).sort(), [...GUIDE_KEYS].sort(), '新增篇目時要決定它在手機上適不適用')
  for (const g of list) assert.ok(['desktop', 'part', 'phone'].includes(g.fit), g.key)
})

test('電腦才能做的篇目註明「電腦版功能」並說明原因；手機也能用的不亂標', () => {
  const by = Object.fromEntries(phoneGuideList().map(g => [g.key, g]))
  for (const k of ['bridge', 'cloud']) { assert.equal(by[k].badge, '電腦版功能'); assert.ok(by[k].note.length > 10, k) }
  assert.match(by.start.badge, /電腦版/); assert.equal(by.groups.fit, 'phone'); assert.equal(by.faq.badge, '')
})

test('單篇：內容就是電腦版那一份（同一個物件），不存在的鍵回 null', () => {
  assert.equal(phoneGuide('faq').guide, GUIDES.find(g => g.key === 'faq'))
  assert.equal(phoneGuide('nope'), null)
  assert.equal(phoneGuide(undefined), null)
})

test('導覽：蓋在設置分頁上；壞的篇目鍵退回篇目列表；舊記錄照常', () => {
  assert.deepEqual(guideNav(), { tab: 'me', sheet: 'guide', guide: '' })
  assert.deepEqual(guideNav('faq'), { tab: 'me', sheet: 'guide', guide: 'faq' })
  assert.deepEqual(guideNav('../x'), { tab: 'me', sheet: 'guide', guide: '' })
  assert.deepEqual(normalizeNav({ sheet: 'guide', guide: 'start' }), guideNav('start'))
  assert.deepEqual(normalizeNav({ sheet: 'guide', guide: 5 }), guideNav())
})

test('頁面：指引是設置分頁的一個項目、滿版獨立一頁有返回；內文只用文字插值，手機頁面不用 v-html 顯示指引', () => {
  const html = read('ui', 'm.html')
  assert.match(html, /<section class="m-sheet m-guide" v-if="nav\.sheet === 'guide'"/)
  const sheet = /<section class="m-sheet m-guide"[\s\S]*?<\/section>/.exec(html)[0]
  assert.match(sheet, /aria-label="返回"[^>]*@click="back"/, '左上返回')
  assert.doesNotMatch(sheet, /v-html/, '指引頁不用 v-html')
  assert.match(sheet, /<guide-doc :guide="guideOpen\.guide">/)
  assert.match(html, /@click="openGuides"/, '設置分頁有入口')
  const doc = read('ui', 'lib', 'guide-doc.mjs')
  assert.doesNotMatch(doc, /v-html/, '內文元件沿用電腦版的守門：不用 v-html')
  assert.match(read('ui', 'm.js'), /app\.component\('guide-doc', GuideDoc\)/)
})
