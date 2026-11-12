import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TEXT, errorText, normalizeView } from '../ui/lib/known-peers.mjs'

test('認得的電腦：欄位壞的丟掉，名字清掉控制字元', () => {
  const v = normalizeView({ peers: [
    { node: 'hom7a1', name: '家用‮機', fingerprint: '0123456789abcdef', first_seen_ms: 1_800_000_000_000 },
    { node: '', name: 'x' }, { name: '沒節點' }, null,
    { node: 'wrk9b2', name: '', fingerprint: 'ff', first_seen_ms: 'x' },
  ] })
  assert.equal(v.peers.length, 2)
  assert.equal(v.peers[0].name, '家用 機')
  assert.ok(v.peers[0].firstSeen)
  assert.equal(v.peers[1].name, '', '本機記的名字是空的')
  assert.equal(v.peers[1].label, '未命名的電腦', '畫面上顯示未命名（指紋照樣顯示在旁邊）')
  assert.equal(v.peers[0].label, '家用 機')
  assert.equal(v.peers[1].firstSeen, '')
  assert.deepEqual(normalizeView(null), { peers: [] })
})

test('認得的電腦：只能看和忘記，錯誤不露出內部訊息', () => {
  assert.equal(TEXT.forget, '忘記這台')
  assert.equal(errorText(new Error('/home/x/device_known.json 讀不到')), '操作沒有成功，請稍後再試。')
  assert.equal(errorText('記住的設備紀錄壞了'), '記住的設備紀錄壞了，請告訴開發團隊。')
})

test('設備改名：名字只有一個（後台）、最多 40 字；只有 device_rename 與設定頁的 device-rename，舊的本機改名全拿掉', async () => {
  assert.equal(TEXT.unnamed, '未命名的電腦')
  for (const k of ['rename', 'renameSave', 'renameCancel', 'renameLabel', 'renameHint']) assert.equal(TEXT[k], undefined, k)
  assert.equal(normalizeView({ peers: [{ node: 'a', name: '長'.repeat(60) }] }).peers[0].name.length, 40)
  const fs = await import('node:fs')
  const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const panel = read('../ui/lib/settings-panel.mjs')
  const info = panel.slice(panel.indexOf('<div class="dv-info"'), panel.indexOf("<div :class=\"['dv-body'"))
  const old = panel.slice(panel.indexOf('<details class="dv-old-rec"'), panel.indexOf('</details>', panel.indexOf('<details class="dv-old-rec"')))
  assert.ok(info.length > 500 && old.length > 100)
  assert.doesNotMatch(info + old, /v-html/, '名字只當文字')
  assert.match(info, /<b class="dv-curname">\{\{ curDev\.label \}\}<\/b>/)
  assert.match(info, /@click="renameStart">改名</)
  assert.match(info, /v-model="renameText"/)
  assert.match(old, /<b>\{\{ p\.label \}\}<\/b>/)
  assert.doesNotMatch(panel, /known-rename|renameKnown|KNOWN\.rename/)
  const { SETTING_OPS } = await import('../ui/lib/settings-panel.mjs')
  assert.ok(SETTING_OPS.includes('device-rename') && !SETTING_OPS.includes('known-rename'))
  const list = read('../ui/list.js')
  assert.match(list, /case 'device-rename': if \(value\?\.node\) await renameDevice\(value\.node, value\.name\)/)
  assert.match(list, /invoke\('device_rename', \{ node, name/)
  assert.doesNotMatch(list, /device_known_rename/)
  assert.doesNotMatch(read('../src-tauri/src/lib.rs'), /device_known_rename/)
})

test('設定「設備」的詳情頁：忘記只在有紀錄時出現；舊設備紀錄收合、有 N、可忘記；整個畫面沒有「已確認／未確認」', async () => {
  const fs = await import('node:fs')
  const panel = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.match(panel, /<template v-if="curKnown">\s*<span class="pair-btns"><button[^>]*forget\.ask\(curKnown\)">\{\{ KNOWN\.forget \}\}/)
  assert.match(panel, /<summary>舊設備紀錄（\{\{ oldPeers\.length \}\}）<\/summary>/)
  assert.match(panel, /<details class="dv-old-rec" v-if="oldPeers\.length">/)
  assert.match(panel, /role="alert">\{\{ st\.known\.error \}\}/)
  assert.doesNotMatch(panel, /已確認|未確認/)
  assert.doesNotMatch(panel.slice(panel.indexOf("cat === 'devices'"), panel.indexOf("catKey === 'look'")), /認得的電腦/)
})
