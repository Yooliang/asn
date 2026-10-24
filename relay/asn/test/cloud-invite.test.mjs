// 邀請雲端代理（issue #13）：純邏輯、畫面轉得出來、接線守門（Rust 指令登錄、金鑰不落地）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { CloudInvitePanel, COPY_NOTE, DEFAULT_NAME, INVITE_NOTE, agoText, cleanName, joined, rowView, rowsFromList } from '../ui/lib/cloud-invite.mjs'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = Date.parse('2026-10-22T12:00:00Z')

test('名稱：去空白、1～40 字、不含控制字元', () => {
  assert.equal(cleanName('  小真 '), '小真')
  assert.equal(cleanName(''), '')
  assert.equal(cleanName('   '), '')
  assert.equal(cleanName('a\nb'), '')
  assert.equal(cleanName(null), '')
  assert.equal([...cleanName('字'.repeat(40))].length, 40)
  assert.equal(cleanName('字'.repeat(41)), '')
  assert.equal(DEFAULT_NAME, '雲端代理')
})

test('多久以前', () => {
  assert.equal(agoText('2026-10-22T11:59:30Z', NOW), '不到 1 分鐘前')
  assert.equal(agoText('2026-10-22T11:55:00Z', NOW), '5 分鐘前')
  assert.equal(agoText('2026-10-22T09:00:00Z', NOW), '3 小時前')
  assert.equal(agoText('2026-10-20T12:00:00Z', NOW), '2 天前')
  assert.equal(agoText('壞掉', NOW), '')
  assert.equal(agoText(null, NOW), '')
})

test('清單一列：從沒上線＝等代理上線；在線；離線帶最後上線時間；不顯示節點代號', () => {
  assert.deepEqual(rowView({ id: 't5-a', name: '小真', last_seen_at: null, online: false }, NOW).status, '等代理上線')
  assert.equal(rowView({ id: 't5-a', name: '小真', last_seen_at: null }, NOW).state, 'waiting')
  const on = rowView({ id: 't5-a', name: '小真', last_seen_at: '2026-10-22T11:59:00Z', online: true }, NOW)
  assert.deepEqual([on.state, on.status], ['online', '在線'])
  const off = rowView({ id: 't5-a', name: '小真', last_seen_at: '2026-10-22T09:00:00Z', online: false }, NOW)
  assert.deepEqual([off.state, off.status], ['offline', '離線，最後上線：3 小時前'])
  assert.equal(rowView({ id: 'x', name: '' }, NOW).name, '雲端代理', '沒名字給預設，不退回代號')
})

test('後台回應 → 清單：格式不對的丟掉；剛建立的代理有人連上來才算已加入', () => {
  assert.deepEqual(rowsFromList(null), [])
  assert.deepEqual(rowsFromList({ nodes: 'x' }), [])
  const rows = rowsFromList({ nodes: [{ id: 'a', name: 'A', last_seen_at: null }, null, { name: '沒代號' }, { id: 'b', name: 'B', last_seen_at: '2026-10-22T11:59:00Z', online: true }] }, NOW)
  assert.deepEqual(rows.map(r => r.id), ['a', 'b'])
  assert.equal(joined(rows, 'a'), false)
  assert.equal(joined(rows, 'b'), true)
  assert.equal(joined(rows, 'zzz'), false)
})

test('說明文字：金鑰只顯示一次、貼到秘密環境變數；給代理的說明沒有金鑰', () => {
  assert.match(COPY_NOTE, /只會顯示這一次.*關掉就再也看不到/)
  assert.match(COPY_NOTE, /ASN_RELAY_KEY/)
  assert.match(COPY_NOTE, /秘密環境變數/)
  assert.match(INVITE_NOTE, /沒有金鑰/)
})

test('元件轉得出來：登入後有「邀請雲端代理」鈕；畫面純中文、不出現節點代號字樣', async () => {
  globalThis.Vue = Vue
  const html = await renderToString(Vue.createSSRApp({ render: () => Vue.h(CloudInvitePanel) }))
  for (const w of ['雲端代理', '邀請雲端代理']) assert.ok(html.includes(w), w)
  assert.ok(!/節點/.test(html), '一般使用者看不到「節點」這種字')
  assert.ok(!/localStorage/.test(html))
})

test('設定「帳號」分類裡有雲端代理區塊；別的分類沒有', async () => {
  globalThis.Vue = Vue
  const st = { accounts: { list: [], current: null, codexLine: '', busy: false, confirmDel: '', msg: '', trustOwn: false, autoAdd: false, autoNote: '', mod: '', remote: { node: '', devices: [], list: [], loading: false, busy: false, msg: '' } }, notify: {}, upd: { status: { tone: 'ok', head: '', lines: [] } } }
  const render = key => renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey: key, meAv: '' }) }))
  assert.ok((await render('devices')).includes('邀請雲端代理'))
  assert.ok(!(await render('look')).includes('邀請雲端代理'))
})

test('守門：金鑰只在元件記憶體——不寫 localStorage／檔案／記錄，也不放進給代理的說明', () => {
  const js = read('ui/lib/cloud-invite.mjs').split(String.fromCharCode(10)).filter(l => !l.trim().startsWith('//')).join(String.fromCharCode(10))   // 註解不算
  for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'console.', 'store_save', 'store(']) assert.ok(!js.includes(banned), `不該出現 ${banned}`)
  assert.match(js, /onUnmounted\(.*created\.value = null/, '離開畫面就丟掉金鑰')
  assert.match(js, /const done = \(\) => \{ created\.value = null/, '按完成就丟掉金鑰')
  // 給代理的說明用的是 created.invite（Rust 組好、不含金鑰），不是自己拼 key
  const line = js.split(String.fromCharCode(10)).find(l => l.includes('const copyInvite'))
  assert.ok(line && line.includes('created.value.invite') && !line.includes('.key'))
})

test('接線：前端三個指令都在 Rust 登錄；撤銷是兩段式（先「撤銷」再「確認撤銷」）', () => {
  const tauri = read('ui/lib/tauri.mjs')
  const lib = read('src-tauri/src/lib.rs')
  for (const cmd of ['cloud_agent_create', 'cloud_agent_list', 'cloud_agent_revoke']) {
    assert.ok(tauri.includes(`invoke('${cmd}'`), `${cmd} 前端有呼叫`)
    assert.ok(lib.includes(`cloud_invite::${cmd}`), `${cmd} 有登錄`)
    assert.match(read('src-tauri/src/cloud_invite.rs'), new RegExp(`pub async fn ${cmd}\\(`))
  }
  assert.ok(lib.includes('mod cloud_invite;'))
  assert.ok(read('ui/lib/cloud-invite.mjs').includes("confirmId.value !== id"))
})

test('Rust 端：只用登入憑證（Authorization）呼叫後台三個動作，不帶節點金鑰；說明的網址是官網技能說明', () => {
  const rs = read('src-tauri/src/cloud_invite.rs')
  const prod = rs.slice(0, rs.indexOf('#[cfg(test)]'))
  for (const a of ['cloud_node_create', 'cloud_node_list', 'cloud_node_revoke']) assert.ok(prod.includes(`"${a}"`), a)
  assert.ok(prod.includes('https://asnmessenger.web.app/skill/asn-cloud-agent.md'))
  assert.ok(!prod.includes('x-relay-key') && !prod.includes('Some(&id.key)'), '雲端代理邀請不碰節點金鑰')
})

test('核准無畫面主機：前端指令有登錄、走登入憑證、畫面有入口、金鑰不經過這裡', async () => {
  assert.ok(read('ui/lib/tauri.mjs').includes("invoke('cloud_agent_approve'"))
  assert.ok(read('src-tauri/src/lib.rs').includes('cloud_invite::cloud_agent_approve'))
  const rs = read('src-tauri/src/cloud_invite.rs')
  assert.match(rs, /pub async fn cloud_agent_approve\(/)
  assert.ok(rs.includes('"device_code_approve"'))
  const js = read('ui/lib/cloud-invite.mjs')
  assert.ok(js.includes('輸入短碼核准主機') && js.includes('cloudApi.approve('))
  const ap = js.slice(js.indexOf('const approve = async'), js.indexOf('const justJoined'))
  assert.ok(!/\.key\b/.test(ap), '核准流程不碰金鑰')
})
