// 守門（#2105 搬頁面：登入面板、雲端邀請面板、語音辨識下載）：
// 這三處一律用共用按鈕——不再出現舊 class、不再有裸 <button>；取消在左、確定在右（主要鈕）；登出／撤銷／結束是危險鈕。
// 規範見 docs/畫面規範.md 第二、四節。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const LOGIN = read('../ui/lib/login-panel.mjs')
const CLOUD = read('../ui/lib/cloud-invite.mjs')
const CHAT = read('../ui/lib/chatpane.mjs')
// 聊天窗只管語音辨識下載那一區（其餘按鈕不在這一張範圍）
const VOICE = CHAT.slice(CHAT.indexOf('class="voice-install"'), CHAT.indexOf('class="reply-bar"'))

const SCOPES = { '登入面板': LOGIN, '雲端邀請面板': CLOUD, '語音辨識下載': VOICE }

/** 取出所有共用按鈕：{ text, attrs, at } */
const buttons = src => [...src.matchAll(/<asn-button([^>]*)>([\s\S]*?)<\/asn-button>/g)].map(m => ({ attrs: m[1], text: m[2], at: m.index }))
const find = (src, click, nth = -1) => {
  const hit = buttons(src).filter(b => b.attrs.includes(`@click="${click}"`))
  if (nth < 0) assert.equal(hit.length, 1, `找不到唯一的按鈕：${click}`)
  return hit[Math.max(nth, 0)]
}

test('#2105 三處不再有舊按鈕 class、不再有裸 <button>', () => {
  assert.ok(VOICE.length > 100, '有取到語音辨識下載那一區')
  for (const [name, src] of Object.entries(SCOPES)) {
    assert.ok(!src.includes('aero-btn'), `${name}還有舊 class`)
    assert.ok(!/<button[\s>]/.test(src), `${name}還有裸 <button>`)
    assert.ok(buttons(src).length >= 2, `${name}要有共用按鈕`)
  }
})

test('#2105 三個元件都有註冊共用元件（否則共用按鈕畫不出來）', () => {
  assert.equal((LOGIN.match(/components: \{ \.\.\.UI_KIT \}/g) || []).length, 2, '登入與登出兩個面板')
  assert.match(CLOUD, /components: \{ \.\.\.UI_KIT \}/)
  assert.match(CHAT, /components: \{ \.\.\.UI_KIT,/)
})

test('#2105 成對的確認：取消在左、確定在右，確定是主要鈕，放在動作列裡', () => {
  const pairs = [
    ['雲端邀請：建立', CLOUD, 'form = false', 'create'],
    ['雲端邀請：核准', CLOUD, 'approveForm = false', 'approve'],
    ['雲端邀請：改名儲存', CLOUD, 'cancelRename', 'rename'],
    ['語音辨識下載', VOICE, 'voice.dismissInstall()', 'voice.installStt()'],
  ]
  for (const [name, src, no, yes] of pairs) {
    const n = find(src, no), y = find(src, yes)
    assert.ok(n.at < y.at, `${name}：取消要在確定左邊`)
    assert.match(n.text, /^取消$/, `${name}：取消字樣`)
    assert.ok(!/level="primary"/.test(n.attrs), `${name}：取消不是主要鈕`)
    assert.match(y.attrs, /level="primary"/, `${name}：確定是主要鈕`)
    const between = src.slice(n.at, y.at)
    assert.ok(!between.includes('</asn-actions>'), `${name}：兩顆在同一個動作列`)
    assert.ok(src.lastIndexOf('<asn-actions>', n.at) > src.lastIndexOf('</asn-actions>', n.at), `${name}：取消在動作列裡`)
  }
  // 登出確認：取消在最左，後面才是兩種登出
  const c = find(LOGIN, 'cancel', 1), a = find(LOGIN, 'logout(false)'), b = find(LOGIN, 'logout(true)')
  assert.ok(c.at < a.at && a.at < b.at, '登出確認：取消、只登出、登出並結束')
  assert.ok(LOGIN.lastIndexOf('<asn-actions>', c.at) > LOGIN.lastIndexOf('</asn-actions>', c.at), '登出確認在動作列裡')
})

test('#2105 登出、撤銷、結束是危險鈕；取消與一般動作不是', () => {
  for (const click of ['ask', 'logout(false)', 'logout(true)']) assert.match(find(LOGIN, click).attrs, /state="danger"/, `登出類：${click}`)
  assert.match(find(CLOUD, 'revoke(r.id)').attrs, /state="danger"/, '撤銷')
  for (const [src, click, nth] of [[LOGIN, 'cancel', 0], [LOGIN, 'cancel', 1], [CLOUD, 'openRename(r)'], [CLOUD, 'create'], [VOICE, 'voice.dismissInstall()']]) {
    assert.ok(!/state="danger"/.test(find(src, click, nth).attrs), `${click} 不該是危險鈕`)
  }
  // 文字沒被改
  assert.equal(find(CLOUD, 'revoke(r.id)').text, "{{ confirmId === r.id ? '確認撤銷' : '撤銷' }}")
  assert.equal(find(LOGIN, 'ask').text, '登出')
})
