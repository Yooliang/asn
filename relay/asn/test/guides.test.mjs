// 「指引」頁籤：說明資料完整、列表只列標題並開共用對話框（不再開右邊分頁）、守門（不放金鑰與內部網址、不用 v-html）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { GUIDES, GUIDE_KEYS, guideByKey, numbered } from '../ui/lib/guides.mjs'

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
  assert.ok(/ASN_RELAY_KEY/.test(text('cloud')) && /boot\.sh/.test(text('cloud')) && /inbox\.mjs/.test(text('cloud')) && /send\.mjs/.test(text('cloud')) && /--reply-to/.test(text('cloud')))
  assert.ok(/asn-cli room --rooms/.test(text('groups')) && /--room-read/.test(text('groups')) && /唯讀|只讀|只能「看」/.test(text('groups')))
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

test('守門：指引畫面一律用文字插值（沒有 v-html）；點一篇開聊天窗（整合＝右邊分頁、分離＝獨立視窗），不再彈對話框；沒有任何外部腳本', () => {
  const dir = new URL('../ui/', import.meta.url)
  const read = f => fs.readFileSync(new URL(f, dir), 'utf8').replace(/\r\n/g, '\n')
  const html = read('list.html'), js = read('list.js'), doc = read('lib/guide-doc.mjs'), panelHtml = read('panel.html'), panelJs = read('panel.js')
  const guideBlock = /<div class="list guide-list"[\s\S]*?<\/ul>/.exec(html)[0]
  assert.ok(!/v-html/.test(guideBlock), '指引清單不用 v-html')
  assert.ok(!/v-html/.test(doc), '指引內文不用 v-html')
  assert.ok(doc.includes('numbered(props.guide.blocks)') && /export const GuideDoc/.test(doc))
  assert.ok(js.includes("app.component('guide-doc', GuideDoc)") && panelJs.includes("app.component('guide-doc', GuideDoc)"), '兩邊用同一個元件')
  assert.ok(!html.includes('guide-tab') && !html.includes('guide-pane') && !/view === 'guide'/.test(html), '舊的右邊指引分頁（view 切換）都拿掉了')
  assert.ok(!/rightView|openGuide\b|hideGuide|showGuide|openedGuide|openGuideDlg|dlg\.kind|closeDlg/.test(js + html), '舊的分頁與對話框邏輯都拿掉了')
  assert.ok(html.includes('@click="openPanel(\'guide\', g.key)"'), '點標題開指引聊天窗')
  assert.ok(html.includes('<guide-doc v-if="k === \'guide\'" :guide="panelGuide">'), '整合模式內容放在右邊的面板分頁')
  assert.ok(panelHtml.includes('<guide-doc v-if="kind === \'guide\' && guide"'), '分離模式內容放在獨立視窗')
  assert.ok(!/b-psm">\{\{ g\.sub/.test(html), '列表只列標題')
  assert.ok(!/<script[^>]+src="https?:/.test(html + panelHtml), '不載入外部腳本')
})
