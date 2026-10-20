// 「指引」頁籤：說明資料完整、開關指引的狀態切換、整合模式右邊該顯示什麼、守門（不放金鑰與內部網址、不用 v-html）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { GUIDES, GUIDE_KEYS, closeGuide, guideByKey, hideGuide, numbered, openGuide, rightView } from '../ui/lib/guides.mjs'
import { tabVisible } from '../ui/lib/merge.mjs'

test('指引清單：五篇、順序與鍵固定、每篇有標題與副標、內容有步驟', () => {
  assert.deepEqual(GUIDE_KEYS, ['start', 'bridge', 'cloud', 'groups', 'faq'])
  assert.deepEqual(GUIDES.map(g => g.title), ['開始使用 ASN', '讓這台電腦的 Claude 視窗出現在名單上', '讓雲端 AI 代理加入', '群組怎麼用', '常見問題'])
  assert.equal(new Set(GUIDE_KEYS).size, GUIDES.length)
  for (const g of GUIDES) {
    assert.ok(g.title && g.sub, g.key)
    assert.ok(g.blocks.length >= 5, `${g.key} 內容太少`)
    assert.ok(g.blocks.some(b => b.k === 'li'), `${g.key} 沒有步驟`)
    for (const b of g.blocks) { assert.ok(['h', 'p', 'li', 'code', 'note'].includes(b.k), `${g.key} 區塊種類 ${b.k}`); assert.ok(typeof b.t === 'string' && b.t.trim(), `${g.key} 有空區塊`) }
  }
  assert.equal(guideByKey('bridge').title, GUIDES[1].title)
  assert.equal(guideByKey('nope'), null)
})

test('指引內容的出處：各篇提到的關鍵步驟都在（對照 repo 文件）', () => {
  const text = k => guideByKey(k).blocks.map(b => b.t).join('\n')
  assert.ok(/1 到 40 個字/.test(text('start')) && /收發室/.test(text('start')) && /不會回報給收發室/.test(text('start')))
  assert.ok(/安裝\.cmd/.test(text('bridge')) && /邀請碼/.test(text('bridge')) && /Node\.js 22/.test(text('bridge')) && /bridge\.log/.test(text('bridge')) && /解除安裝\.cmd/.test(text('bridge')))
  assert.ok(/IRORI_RELAY_KEY/.test(text('cloud')) && /boot\.sh/.test(text('cloud')) && /inbox\.mjs/.test(text('cloud')) && /send\.mjs/.test(text('cloud')) && /--reply-to/.test(text('cloud')))
  assert.ok(/room\.mjs --rooms/.test(text('groups')) && /--room-read/.test(text('groups')) && /唯讀|只讀|只能「看」/.test(text('groups')))
  for (const w of ['沒回覆', '名字改了', '狀態燈', '震動']) assert.ok(guideByKey('faq').blocks.some(b => b.k === 'h' && b.t.includes(w)), w)
})

test('守門：說明裡沒有金鑰、內部網址與後台網址、使用者專屬路徑；路徑用通用寫法', () => {
  const all = JSON.stringify(GUIDES)
  assert.ok(!/https?:\/\//i.test(all), '不放任何網址')
  assert.ok(!/supabase|firebase|hwtahctsgjcemtwzlvnq|127\.0\.0\.1|localhost/i.test(all))
  assert.ok(!/sk-[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{40,}={0,2}/.test(all), '不像金鑰的長字串')
  assert.ok(!/[A-Za-z]:\Users\|cwen0708|D:\Github|C:\Users/.test(all), '不放個人路徑')
  assert.ok(all.includes('%USERPROFILE%'), '用 %USERPROFILE% 的通用寫法')
  for (const g of GUIDES) for (const b of g.blocks) assert.ok(!/<[a-z/][^>]*>/i.test(b.t), `${g.key} 不放 HTML`)
})

test('步驟編號：連續的步驟從 1 數，遇到小標、指令或注意事項就重數；不改原資料', () => {
  const rows = numbered([{ k: 'h', t: 'a' }, { k: 'li', t: 'x' }, { k: 'li', t: 'y' }, { k: 'code', t: 'c' }, { k: 'li', t: 'z' }, { k: 'p', t: 'p' }])
  assert.deepEqual(rows.map(r => r.n), [0, 1, 2, 0, 1, 0])
  assert.equal(GUIDES[0].blocks.some(b => 'n' in b), false)
})

test('開啟指引：分離模式只記哪一篇（顯示在名單內容區）；整合模式同時選到右邊的指引分頁；不認得的鍵不動', () => {
  assert.deepEqual(openGuide({ guide: '', showGuide: false }, 'faq', 'split'), { guide: 'faq', showGuide: false })
  assert.deepEqual(openGuide({ guide: '', showGuide: false }, 'faq', 'merged'), { guide: 'faq', showGuide: true })
  assert.deepEqual(openGuide({ guide: 'start', showGuide: true }, 'cloud', 'merged'), { guide: 'cloud', showGuide: true }, '換一篇＝同一個分頁換內容')
  assert.deepEqual(openGuide({ guide: 'start', showGuide: true }, 'nope', 'merged'), { guide: 'start', showGuide: true })
  assert.deepEqual(openGuide(undefined, 'nope', 'merged'), { guide: '', showGuide: false })
  assert.deepEqual(closeGuide(), { guide: '', showGuide: false })
  assert.deepEqual(hideGuide({ guide: 'faq', showGuide: true }), { guide: 'faq', showGuide: false }, '切去別的分頁：指引留著但退到背景')
})

test('整合模式右邊顯示什麼：指引分頁選著＝指引；否則有對話＝對話；都沒有＝「開始」大幅廣告', () => {
  assert.equal(rightView({}), 'home')
  assert.equal(rightView({ tabs: ['a'] }), 'chat')
  assert.equal(rightView({ tabs: [], guide: 'faq', showGuide: true }), 'guide')
  assert.equal(rightView({ tabs: ['a'], guide: 'faq', showGuide: true }), 'guide')
  assert.equal(rightView({ tabs: ['a'], guide: 'faq', showGuide: false }), 'chat')
  assert.equal(rightView({ tabs: [], guide: 'faq', showGuide: false }), 'home', '指引在背景、沒有對話＝回到開始頁')
  assert.equal(rightView({ tabs: ['a'], guide: 'nope', showGuide: true }), 'chat', '壞的鍵不會顯示空白頁')
})

test('指引蓋住對話時，來信要算未讀（對話不算看得到）', () => {
  assert.equal(tabVisible({ active: 'a', showGuide: false }, 'a', true), true)
  assert.equal(tabVisible({ active: 'a', showGuide: true }, 'a', true), false)
  assert.equal(tabVisible({ active: 'a' }, 'a', true), true, '舊狀態沒有 showGuide 欄位照常')
})

test('守門：指引畫面一律用文字插值（沒有 v-html）；整合模式的指引是右邊分頁，分離模式在名單內容區；沒有任何外部腳本', () => {
  const dir = new URL('../ui/', import.meta.url)
  const html = fs.readFileSync(new URL('list.html', dir), 'utf8'), js = fs.readFileSync(new URL('list.js', dir), 'utf8')
  const guideBlock = /<div class="list guide-list"[\s\S]*?<\/ul>/.exec(html)[0]
  assert.ok(!/v-html/.test(guideBlock), '指引清單不用 v-html')
  const comp = /app\.component\('guide-doc'[\s\S]*?\n\}\)/.exec(js)[0]
  assert.ok(!/v-html/.test(comp), '指引內文不用 v-html')
  assert.ok(html.includes('v-else-if="view === \'guide\'"') && html.includes('class="ctab guide-tab"'), '整合模式：右邊有指引分頁與內容')
  assert.ok(html.includes("ui.mode === 'split' && openedGuide"), '分離模式：在名單內容區顯示')
})
