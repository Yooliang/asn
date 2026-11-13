// 「關於」頁（#1439）：電腦、手機讀同一份內容；連結網址、使用指引走 App 內頁。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { ABOUT_INTRO, ABOUT_LINKS, ABOUT_MAKER, aboutView, isAboutUrl } from '../ui/lib/about-info.mjs'
import { GUIDE_ENTRY_LABEL } from '../ui/lib/mobile-guides.mjs'

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')

test('內容：簡介、版本、設備名稱、出品', () => {
  const v = aboutView({ deviceName: '小良的筆電' })
  assert.match(v.intro, /Agent Sync Network/)
  assert.equal(v.intro, ABOUT_INTRO)
  assert.equal(v.deviceLine, '這台設備：小良的筆電')
  assert.equal(v.maker, ABOUT_MAKER); assert.match(ABOUT_MAKER, /Yooliang/)
  assert.equal(aboutView({ deviceName: '  ' }).deviceLine, '', '沒有名稱就不顯示那一行')
})

test('連結：外部網址正確，使用指引不在外部連結裡（走 App 內頁）', () => {
  assert.deepEqual(ABOUT_LINKS.map(l => [l.label, l.url]), [
    ['官網', 'https://asnmessenger.web.app/'],
    ['版本紀錄', 'https://asnmessenger.web.app/log'],
    ['隱私權政策', 'https://asnmessenger.web.app/privacy'],
  ])
  assert.ok(ABOUT_LINKS.every(l => /^https:\/\//.test(l.url)))
  assert.equal(aboutView().guideLabel, GUIDE_ENTRY_LABEL)
  assert.ok(!ABOUT_LINKS.some(l => l.label === GUIDE_ENTRY_LABEL))
  assert.ok(isAboutUrl('https://asnmessenger.web.app/privacy')); assert.ok(!isAboutUrl('https://evil.example/')); assert.ok(!isAboutUrl('file:///c:/x'))
  for (const p of ['log.html', 'privacy.html']) assert.ok(existsSync(new URL(`../../../site/public/${p}`, import.meta.url)), `官網少了 ${p}`)
})

test('電腦、手機都讀同一份（不各寫一次）', () => {
  const desk = read('../ui/lib/settings-panel.mjs'), deskJs = read('../ui/list.js'), mob = read('../ui/m.js'), mobHtml = read('../ui/m.html')
  assert.match(desk, /from '\.\/about-info\.mjs'/); assert.match(mob, /from '\.\/lib\/about-info\.mjs'/)
  assert.match(deskJs, /isAboutUrl/); assert.match(mob, /isAboutUrl/)
  for (const s of [desk, mob, mobHtml]) assert.ok(!s.includes('Agent Sync Network') && !s.includes('/log`') && !s.includes('web.app/log'), '文字與網址只寫在 about-info.mjs')
  assert.match(desk, /act\('open-link', l\.url\)/); assert.match(mobHtml, /openAboutLink\(l\.url\)/)
  assert.match(deskJs, /case 'open-link':[^\n]*invoke\('open_link', \{ url: value \}\)/); assert.match(mob, /invoke\('open_link', \{ url \}\)/)
})

test('使用指引：開 App 內的指引頁，不開外部瀏覽器', () => {
  assert.match(read('../ui/lib/settings-panel.mjs'), /act\('open-guide'\)/)
  assert.match(read('../ui/list.js'), /case 'open-guide': await openPanel\('guide'/)
  assert.match(read('../ui/m.html'), /class="m-row-btn m-about-guide" type="button" @click="openGuides"/)
})
