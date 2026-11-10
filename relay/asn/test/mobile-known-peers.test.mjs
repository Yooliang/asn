// 手機確認電腦的指紋、設定頁「認得的電腦」：文字、整理資料、確認與忘記前先過本人確認
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { TEXT, fpSuffix, makeKnownPeers, needsConfirm, normalizeList, peerOf, errorText } from '../ui/lib/mobile-known-peers.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const FP = '0123456789abcdef'

test('文字：頂端條、浮層、按鈕都是繁體中文，名字和指紋照規格放進去', () => {
  assert.equal(TEXT.stripTitle, '這台還沒確認指紋')
  assert.equal(TEXT.stripButton, '確認指紋')
  assert.equal(TEXT.sheetTitle('工作機'), '確認「工作機」的指紋')
  assert.equal(TEXT.sheetBody('01234567'), '請到那台電腦的設定頁，確認那裡顯示的這台電腦指紋是 01234567。一樣再按「記住這台」。')
  assert.equal(TEXT.remember, '記住這台')
  assert.equal(TEXT.decline, '不要')
  assert.equal(TEXT.forget, '忘記')
  assert.equal(TEXT.confirmed, '已確認')
  assert.equal(TEXT.unconfirmed, '還沒確認')
  assert.equal(TEXT.settingTitle, '認得的電腦')
  assert.equal(TEXT.fp('01234567'), '指紋 01234567')
  for (const t of Object.values(TEXT).map(x => (typeof x === 'function' ? x('示範', '01234567') : x))) assert.doesNotMatch(t, /[A-Za-z]{3,}/, t)
})

test('指紋寫法和電腦版一樣：名字後面接「（指紋 xxxxxxxx）」', () => {
  assert.equal(fpSuffix('01234567'), '（指紋 01234567）')
  const rs = read('../src-tauri/src/input_consent.rs')
  assert.ok(rs.includes('（指紋 {'), '電腦版確認框的寫法')
})

test('peerOf：指紋要是 16 個小寫十六進位字元，前 8 碼一律從完整指紋切；沒確認、壞資料不顯示', () => {
  const p = peerOf({ id: 'x', node: 'pc', fp: FP, fp8: 'ffffffff', confirmed: false }, '工作機')
  assert.deepEqual(p, { node: 'pc', fp: FP, fp8: '01234567', confirmed: false, name: '工作機' })
  assert.equal(needsConfirm(p), true)
  assert.equal(needsConfirm(peerOf({ node: 'pc', fp: FP, confirmed: true })), false)
  assert.equal(peerOf({ node: 'pc', fp: FP, confirmed: 'true' }).confirmed, false, '只認布林 true')
  assert.equal(peerOf({ node: 'pc', fp: 'ABCDEF0123456789' }), null)
  assert.equal(peerOf({ node: 'pc', fp: '01234567' }), null)
  assert.equal(peerOf({ fp: FP }), null)
  assert.equal(peerOf(null), null)
  assert.equal(needsConfirm(null), false)
  assert.equal(peerOf({ node: 'pc', fp: FP }, '').name, '那台電腦')
})

test('normalizeList：只留名字、節點、指紋前 8 碼、有沒有確認；壞的丟掉、不帶完整指紋', () => {
  const raw = { peers: [{ node: 'a', name: '甲\n機', fp8: '01234567', confirmed: true, sign_pub: 'SECRET', fp: FP }, { node: 'b', fp8: 'zz' }, { name: 'x' }, { node: 'c', name: '丙', fp8: 'abcdef01' }] }
  const l = normalizeList(raw)
  assert.deepEqual(l, [{ node: 'a', name: '甲 機', fp8: '01234567', confirmed: true }, { node: 'c', name: '丙', fp8: 'abcdef01', confirmed: false }])
  assert.doesNotMatch(JSON.stringify(l), /SECRET|0123456789abcdef/)
  assert.deepEqual(normalizeList(null), [])
})

test('errorText：只顯示白話，不洩漏內部訊息', () => {
  assert.equal(errorText(new Error('boom /data/user/0/x')), TEXT.failed)
  assert.match(errorText(new Error('這支手機沒有設定螢幕鎖，請先設定再操作')), /螢幕鎖/)
})

function fake(result, answers = {}) {
  const calls = []
  const api = makeKnownPeers({
    confirm: async () => { calls.push('confirm'); return result },
    invoke: async (cmd, args) => { calls.push([cmd, args]); return cmd in answers ? answers[cmd] : true },
  })
  return { api, calls }
}

test('記住這台：先過本人確認，通過才叫 android_known_confirm，帶完整指紋', async () => {
  const { api, calls } = fake('ok')
  assert.equal(await api.remember({ node: 'pc', fp: FP }), 'done')
  assert.deepEqual(calls, ['confirm', ['android_known_confirm', { node: 'pc', fp: FP }]])
})

test('記住這台：本人取消、沒設螢幕鎖都不送；Rust 沒記到回 not_ready；指紋壞了連確認都不叫', async () => {
  let f = fake('cancel')
  assert.equal(await f.api.remember({ node: 'pc', fp: FP }), 'cancel')
  assert.deepEqual(f.calls, ['confirm'])
  f = fake('no_lock')
  await assert.rejects(() => f.api.remember({ node: 'pc', fp: FP }), /螢幕鎖/)
  assert.deepEqual(f.calls, ['confirm'])
  f = fake('ok', { android_known_confirm: false })
  assert.equal(await f.api.remember({ node: 'pc', fp: FP }), 'not_ready')
  f = fake('ok')
  assert.equal(await f.api.remember({ node: 'pc', fp: 'bad' }), 'not_ready')
  assert.deepEqual(f.calls, [])
})

test('忘記：先過本人確認才叫 android_known_forget；取消就不送', async () => {
  let f = fake('ok')
  assert.equal(await f.api.forget('pc'), 'done')
  assert.deepEqual(f.calls, ['confirm', ['android_known_forget', { node: 'pc' }]])
  f = fake('cancel')
  assert.equal(await f.api.forget('pc'), 'cancel')
  assert.deepEqual(f.calls, ['confirm'])
  f = fake('no_lock')
  await assert.rejects(() => f.api.forget('pc'), /螢幕鎖/)
  assert.deepEqual(f.calls, ['confirm'])
})

test('守門：android_known_confirm／forget 只有 mobile-known-peers.mjs 叫，而且前面一定先 gate；其他地方不叫', () => {
  const src = read('../ui/lib/mobile-known-peers.mjs')
  for (const cmd of ['android_known_confirm', 'android_known_forget']) {
    const i = src.indexOf(`'${cmd}'`)
    assert.ok(i > 0)
    const start = Math.max(src.lastIndexOf('remember:', i), src.lastIndexOf('forget:', i))
    assert.ok(src.slice(start, i).includes('await gate()'), `${cmd} 前要先過本人確認`)
  }
  for (const f of ['../ui/m.js', '../ui/m.html', '../ui/lib/mobile-remote-view.mjs', '../ui/lib/term-remote.mjs', '../ui/lib/chatpane.mjs']) {
    assert.doesNotMatch(read(f), /android_known_(confirm|forget)/, `${f} 不直接叫`)
  }
  assert.doesNotMatch(read('../ui/m.js'), /invoke\('android_known_/)
})

test('m.html：確認浮層與設定列只用文字節點，不走 v-html；按鈕接到先確認的流程', () => {
  const html = read('../ui/m.html')
  const sheet = html.slice(html.indexOf('v-if="vp.sheet && vp.cur"'), html.indexOf('<group-sheet'))
  assert.doesNotMatch(sheet, /v-html/)
  assert.match(sheet, /\{\{ peerSheetTitle \}\}/)
  assert.match(sheet, /\{\{ peerSheetBody \}\}/)
  assert.match(sheet, /@click="rememberPeer">\{\{ KNOWN_TEXT\.remember \}\}/)
  assert.match(sheet, /@click="closePeerSheet">\{\{ KNOWN_TEXT\.decline \}\}/)
  assert.match(html, /v-if="chatFriend && peerStrip"/)
  assert.match(html, /@click="openPeerSheet">\{\{ KNOWN_TEXT\.stripButton \}\}/)
  assert.match(html, /@remote-started="onRemoteStarted" @remote-ended="onRemoteEnded"/)
  assert.match(html, /@click="forgetKnown\(p\.node\)">\{\{ KNOWN_TEXT\.forget \}\}/)
  const js = read('../ui/m.js')
  assert.match(js, /knownPeers\.remember\(cur\)/)
  assert.match(js, /knownPeers\.forget\(node\)/)
})

test('chatpane／RemoteView 把開始與結束交給手機畫面；開始時帶上那台的名字', () => {
  const tr = read('../ui/lib/term-remote.mjs')
  assert.match(tr, /emit\('started', \{ \.\.\.r, machine: props\.machine \|\| props\.node \}\)/)
  assert.match(tr, /emits: \['cancel', 'started', 'ended'\]/)
  assert.match(read('../ui/lib/chatpane.mjs'), /@started="\$emit\('remote-started', \$event\)" @ended="\$emit\('remote-ended'\)"/)
})

test('Rust：金鑰變了的說法帶新指紋；手機的開始資料帶 confirmed／fp／fp8；三個命令登記在手機清單', () => {
  const vr = read('../src-tauri/src/view_remote.rs')
  assert.match(vr, /「\{who\}」的金鑰和這支手機記住的不一樣，已經擋下。如果那台重灌或換了電腦，請到那台的設定頁確認指紋是 \{new_fp8\}；確定是那台，再到這支手機的「設定 → 認得的電腦」把它忘掉，重新連一次。/)
  const vd = read('../src-tauri/src/view_d.rs')
  assert.match(vd, /phone_key_changed_text\(&machine, &crate::device_id::fp8\(&to_pub\)\)/)
  assert.match(vd, /v\["confirmed"\]/)
  const lib = read('../src-tauri/src/lib.rs')
  const phone = lib.slice(lib.indexOf('#[cfg(not(desktop))]\n    let builder = builder.invoke_handler('))
  for (const c of ['android_known_list', 'android_known_confirm', 'android_known_forget']) assert.ok(phone.includes(`android::${c}`), c)
  const desk = lib.slice(lib.indexOf('generate_handler!['), lib.indexOf('#[cfg(not(desktop))]\n    let builder = builder.invoke_handler('))
  for (const c of ['android_known_list', 'android_known_confirm', 'android_known_forget']) assert.ok(!desk.includes(c), `電腦版沒有 ${c}`)
  const rs = read('../src-tauri/src/android.rs')
  assert.doesNotMatch(rs, /Scope::Input/)
})
