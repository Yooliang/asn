// 守門（#2105 搬頁面：手機設定頁——登出、雲端邀請、檢查更新）：
// 這一段一律用共用按鈕——不再出現 m-btn；取消在左、主要在右、同在一個動作列；登出與撤銷是危險鈕；m.js 要註冊共用元件。
// 規範見 docs/畫面規範.md 第二、四節。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const HTML = read('../ui/m.html')
const MJS = read('../ui/m.js')
const A = HTML.indexOf(`fourthPage.kind === 'setting'`)
const B = HTML.indexOf(`fourthPage.kind === 'guide'`)
const SET = HTML.slice(A, B)
const EXPECTED_BUTTONS = 18

const buttons = src => [...src.matchAll(/<asn-button([^>]*)>([\s\S]*?)<\/asn-button>/g)].map(m => ({ attrs: m[1], text: m[2], at: m.index }))
const find = click => {
  const hit = buttons(SET).filter(b => b.attrs.includes(`@click="${click}"`))
  assert.equal(hit.length, 1, `找不到唯一的按鈕：${click}`)
  return hit[0]
}

test('#2105 手機設定頁：切得到那一段，沒有 m-btn、沒有裸 <button class="m-btn">', () => {
  assert.ok(A > 0 && B > A && SET.length > 3000, '有取到設定頁那一段')
  assert.ok(!/\bm-btn\b/.test(SET), '設定頁還有舊 m-btn')
  assert.ok(buttons(SET).length >= EXPECTED_BUTTONS, `共用按鈕至少 ${EXPECTED_BUTTONS} 顆`)
})

test('#2105 手機設定頁：雲端邀請三組確認，取消在左、主要在右，同一個動作列', () => {
  const pairs = [['建立', 'cloud.cancelForm', 'cloud.create'], ['核准', 'cloud.cancelApprove', 'cloud.approve'], ['改名儲存', 'cloud.cancelRename', 'cloud.rename']]
  for (const [name, no, yes] of pairs) {
    const n = find(no), y = find(yes)
    assert.ok(n.at < y.at, `${name}：取消要在主要鈕左邊`)
    assert.match(n.text, /CLOUD_TEXT\.cancel/, `${name}：取消字樣`)
    assert.ok(!/level="primary"/.test(n.attrs), `${name}：取消不是主要鈕`)
    assert.match(y.attrs, /level="primary"/, `${name}：主要鈕`)
    assert.ok(!SET.slice(n.at, y.at).includes('</asn-actions>'), `${name}：兩顆在同一個動作列`)
    assert.ok(SET.lastIndexOf('<asn-actions>', n.at) > SET.lastIndexOf('</asn-actions>', n.at), `${name}：取消在動作列裡`)
  }
})

test('#2105 手機設定頁：登出與撤銷是危險鈕，其他不是；文字沒被改', () => {
  assert.match(find('doLogout').attrs, /state="danger"/)
  assert.match(find('cloud.revoke(r.id)').attrs, /state="danger"/)
  for (const click of ['cloud.openRename(r.id)', 'cloud.create', 'cloud.cancelForm', 'checkUpdate(true)']) assert.ok(!/state="danger"/.test(find(click).attrs), `${click} 不該是危險鈕`)
  assert.equal(find('doLogout').text, '登出')
  assert.equal(find('cloud.revoke(r.id)').text, '{{ cloudSt.confirmId === r.id ? CLOUD_TEXT.revokeSure : CLOUD_TEXT.revoke }}')
  assert.match(find('checkUpdate(true)').attrs, /:disabled="upd\.checking \|\| upd\.phase === 'downloading'"/)
})

test('#2105 手機：m.js 註冊共用元件、m.html 載入 kit.css', () => {
  assert.match(MJS, /import \{ UI_KIT \} from '\.\/lib\/ui-kit\.mjs'/)
  assert.match(MJS, /Object\.entries\(UI_KIT\)\)\s*app\.component\(/)
  assert.ok(MJS.indexOf('Object.entries(UI_KIT)') < MJS.indexOf("app.mount('#app')"), '註冊要在 mount 之前')
  assert.match(HTML, /<link rel="stylesheet" href="kit\.css">/)
})
