// 手機確認電腦的指紋、設定頁「認得的電腦」：文字、整理資料、確認與忘記前先過本人確認
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { TEXT, fpSuffix, groupFp, makeKnownPeers, needsConfirm, normalizeList, peerOf, errorText } from '../ui/lib/mobile-known-peers.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const FP = '0123456789abcdef'

test('文字：頂端條、浮層、按鈕都是繁體中文，名字和指紋照規格放進去', () => {
  assert.equal(TEXT.stripTitle, '這台還沒確認指紋')
  assert.equal(TEXT.stripButton, '確認指紋')
  assert.equal(TEXT.sheetTitle('工作機'), '確認「工作機」的指紋')
  assert.equal(TEXT.sheetBody, '請看那台電腦的設定頁，選出和那裡顯示的「這台電腦的指紋」完全一樣的那一組。')
  assert.equal(TEXT.noneOption, '都不一樣')
  assert.equal(TEXT.cancel, '取消')
  assert.equal(TEXT.wrong, '選的和電腦上顯示的不一樣，這次沒有記住。要再確認請重新按「確認指紋」。')
  assert.equal(TEXT.noneMatch, '這台電腦的金鑰可能被換過，請不要記住，並告訴管理的人。')
  assert.equal(TEXT.expired, '太久沒選，請重新按「確認指紋」。')
  assert.equal(TEXT.forget, '忘記')
  assert.equal(TEXT.confirmed, '已確認')
  assert.equal(TEXT.unconfirmed, '還沒確認')
  assert.equal(TEXT.settingTitle, '認得的電腦')
  assert.equal(TEXT.fp('0123 4567 89ab cdef'), '指紋 0123 4567 89ab cdef')
  assert.equal(groupFp('0123456789abcdef'), '0123 4567 89ab cdef', '核對用完整 16 碼分組')
  assert.equal(groupFp('01234567'), '')
  assert.equal(groupFp(null), '')
  for (const t of Object.values(TEXT).map(x => (typeof x === 'function' ? x('示範', '01234567') : x))) assert.doesNotMatch(t, /[A-Za-z]{3,}/, t)
})

test('指紋寫法和電腦版一樣：名字後面接「（指紋 xxxxxxxx）」', () => {
  assert.equal(fpSuffix('01234567'), '（指紋 01234567）')
  const rs = read('../src-tauri/src/input_consent.rs')
  assert.ok(rs.includes('（指紋 {'), '電腦版確認框的寫法')
})

test('peerOf：只要節點；不帶、不收指紋；沒確認、壞資料', () => {
  const p = peerOf({ id: 'x', node: 'pc', fp: FP, fp8: 'ffffffff', confirmed: false }, '工作機')
  assert.deepEqual(p, { node: 'pc', confirmed: false, name: '工作機' }, '就算被塞了 fp 也不收')
  assert.equal(needsConfirm(p), true)
  assert.equal(needsConfirm(peerOf({ node: 'pc', confirmed: true })), false)
  assert.equal(peerOf({ node: 'pc', confirmed: 'true' }).confirmed, false, '只認布林 true')
  assert.equal(peerOf({ fp: FP }), null)
  assert.equal(peerOf(null), null)
  assert.equal(needsConfirm(null), false)
  assert.equal(peerOf({ node: 'pc' }, '').name, '那台電腦')
})

test('normalizeList：沒確認的不顯示指紋；確認過的才顯示分組指紋；壞的丟掉、不帶公鑰', () => {
  const raw = { peers: [{ node: 'a', name: '甲\n機', confirmed: true, sign_pub: 'SECRET', fp: FP }, { node: 'b', name: '乙', confirmed: false, fp: 'abcdef0123456789', fp8: 'abcdef01' }, { name: 'x' }, { node: 'c', confirmed: true, fp: 'zz' }] }
  const l = normalizeList(raw)
  assert.deepEqual(l, [{ node: 'a', name: '甲 機', fpShow: '0123 4567 89ab cdef', confirmed: true }, { node: 'b', name: '乙', fpShow: '', confirmed: false }, { node: 'c', name: '某台電腦', fpShow: '', confirmed: true }])
  assert.doesNotMatch(JSON.stringify(l), /SECRET|abcd/)
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
    invoke: async (cmd, args) => { calls.push([cmd, args]); if (answers[cmd] instanceof Error) throw answers[cmd]; return cmd in answers ? answers[cmd] : true },
  })
  return { api, calls }
}

const OPTS = ['a93c c519 1f2e 3b4d', '1111 2222 3333 4444', '5555 6666 7777 8888', '9999 aaaa bbbb cccc']
const names = calls => calls.map(c => (Array.isArray(c) ? c[0] : c))

test('出題：只帶節點，回題目編號與四個分組選項；格式不對或那台沒記住就是 null', async () => {
  let f = fake('ok', { android_known_challenge: { id: 'q1', options: OPTS } })
  assert.deepEqual(await f.api.challenge({ node: 'pc' }), { id: 'q1', options: OPTS })
  assert.deepEqual(f.calls, [['android_known_challenge', { node: 'pc' }]], '不用先過本人確認、不帶指紋')
  f = fake('ok', { android_known_challenge: { id: 'q1', options: OPTS.slice(0, 3) } })
  assert.equal(await f.api.challenge({ node: 'pc' }), null)
  f = fake('ok', { android_known_challenge: { id: 'q1', options: [...OPTS.slice(0, 3), '<b>x</b>'] } })
  assert.equal(await f.api.challenge({ node: 'pc' }), null)
  f = fake('ok', { android_known_challenge: new Error('not_ready') })
  assert.equal(await f.api.challenge({ node: 'pc' }), null)
  f = fake('ok', { android_known_challenge: new Error('boom') })
  await assert.rejects(() => f.api.challenge({ node: 'pc' }), /boom/)
  assert.equal(await fake('ok').api.challenge(null), null)
})

test('選對：先 android_known_answer，說 right 才過本人確認，通過才叫 android_known_confirm（只帶題目編號）', async () => {
  const { api, calls } = fake('ok', { android_known_answer: 'right' })
  assert.equal(await api.pick('q1', 2), 'done')
  assert.deepEqual(calls, [['android_known_answer', { id: 'q1', pick: 2 }], 'confirm', ['android_known_confirm', { id: 'q1' }]])
})

test('選對但本人取消、沒設螢幕鎖都不記；Rust 沒記到回 not_ready', async () => {
  let f = fake('cancel', { android_known_answer: 'right' })
  assert.equal(await f.api.pick('q1', 0), 'cancel')
  assert.deepEqual(names(f.calls), ['android_known_answer', 'confirm'])
  f = fake('no_lock', { android_known_answer: 'right' })
  await assert.rejects(() => f.api.pick('q1', 0), /螢幕鎖/)
  assert.deepEqual(names(f.calls), ['android_known_answer', 'confirm'])
  f = fake('ok', { android_known_answer: 'right', android_known_confirm: false })
  assert.equal(await f.api.pick('q1', 0), 'not_ready')
})

test('選錯、都不一樣、過期：不過本人確認、不叫 confirm，把 Rust 的話原樣回；-1 是都不一樣', async () => {
  for (const r of ['wrong', 'none', 'expired']) {
    const idx = r === 'none' ? -1 : 1
    const f = fake('ok', { android_known_answer: r })
    assert.equal(await f.api.pick('q1', idx), r)
    assert.deepEqual(f.calls, [['android_known_answer', { id: 'q1', pick: idx }]])
  }
  const f = fake('ok', { android_known_answer: 'weird' })
  await assert.rejects(() => f.api.pick('q1', 1))
  assert.equal(await fake('ok').api.pick('q1', 9), 'expired', '數字不對連 Rust 都不叫')
  assert.equal(await fake('ok').api.pick('', 0), 'expired')
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

test('守門：android_known_confirm／forget 前一定先 gate；先回答、再本人確認、最後才記住；只有 mobile-known-peers.mjs 叫這些命令', () => {
  const src = read('../ui/lib/mobile-known-peers.mjs')
  for (const cmd of ['android_known_confirm', 'android_known_forget']) {
    const i = src.indexOf(`'${cmd}'`)
    assert.ok(i > 0)
    const start = Math.max(src.lastIndexOf('pick:', i), src.lastIndexOf('forget:', i))
    assert.ok(src.slice(start, i).includes('await gate()'), `${cmd} 前要先過本人確認`)
  }
  const pick = src.slice(src.indexOf('pick: async'))
  assert.ok(pick.indexOf("'android_known_answer'") < pick.indexOf('await gate()') && pick.indexOf('await gate()') < pick.indexOf("'android_known_confirm'"), '順序')
  assert.doesNotMatch(src, /remember|{ node: peer.node, fp/, '不再有「記住這台」、不送指紋')
  for (const f of ['../ui/m.js', '../ui/m.html', '../ui/lib/mobile-remote-view.mjs', '../ui/lib/term-remote.mjs', '../ui/lib/chatpane.mjs']) {
    assert.doesNotMatch(read(f), /android_known_(challenge|answer|confirm|forget)/, `${f} 不直接叫`)
  }
  assert.doesNotMatch(read('../ui/m.js'), /invoke\('android_known_/)
})

test('m.html：確認浮層只用文字節點，不走 v-html；四個選項、都不一樣、取消；結果說明放在條下面', () => {
  const html = read('../ui/m.html')
  const sheet = html.slice(html.indexOf('v-if="vp.sheet && vp.cur && vp.ch"'), html.indexOf('<group-sheet'))
  assert.doesNotMatch(sheet, /v-html/)
  assert.match(sheet, /\{\{ peerSheetTitle \}\}/)
  assert.match(sheet, /\{\{ peerSheetBody \}\}/)
  assert.match(sheet, /v-for="\(o, i\) in vp\.ch\.options"[^>]*@click="choosePeer\(i\)">\{\{ o \}\}/)
  assert.match(sheet, /@click="choosePeer\(-1\)">\{\{ KNOWN_TEXT\.noneOption \}\}/)
  assert.match(sheet, /@click="closePeerSheet">\{\{ KNOWN_TEXT\.cancel \}\}/)
  assert.match(html, /v-if="chatFriend && vp\.note"[^>]*>\{\{ vp\.note \}\}/)
  assert.match(html, /v-if="chatFriend && peerStrip"/)
  assert.match(html, /@click="openPeerSheet">\{\{ KNOWN_TEXT\.stripButton \}\}/)
  assert.match(html, /@remote-started="onRemoteStarted" @remote-ended="onRemoteEnded"/)
  assert.match(html, /@click="forgetKnown\(p\.node\)">\{\{ KNOWN_TEXT\.forget \}\}/)
  const js = read('../ui/m.js')
  assert.match(js, /knownPeers\.challenge\(cur\)/)
  assert.match(js, /knownPeers\.pick\(ch\.id, index\)/)
  assert.match(js, /knownPeers\.forget\(node\)/)
  for (const k of ['wrong', 'none', 'expired']) assert.match(js, new RegExp(`${k}: KNOWN_TEXT\\.`))
})

test('chatpane／RemoteView 把開始與結束交給手機畫面；開始時帶上那台的名字', () => {
  const tr = read('../ui/lib/term-remote.mjs')
  assert.match(tr, /emit\('started', \{ \.\.\.r, machine: props\.machine \|\| props\.node \}\)/)
  assert.match(tr, /emits: \['cancel', 'started', 'ended'\]/)
  assert.match(read('../ui/lib/chatpane.mjs'), /@started="\$emit\('remote-started', \$event\)" @ended="\$emit\('remote-ended'\)"/)
})

test('Rust：金鑰變了的說法帶原本與新的完整指紋、名字用本機記住的；手機的開始資料只帶 confirmed 與節點、不帶指紋；五個命令登記在手機清單', () => {
  const vr = read('../src-tauri/src/view_remote.rs')
  assert.match(vr, /\{who\}的金鑰和這支手機記住的不一樣（\{fps\}），已經擋下。/)
  assert.match(vr, /Some\(old\) => format!\("原本的指紋 \{old\}，現在是 \{new_fp\}"\)/)
  assert.match(vr, /None => format!\("現在的指紋是 \{new_fp\}"\)/)
  const vd = read('../src-tauri/src/view_d.rs')
  assert.match(vd, /let old_fp = was_confirmed\.then\(\|\| crate::device_id::fp_grouped\(&old_pub\)\);/, '原本那把沒確認過就不給它的指紋')
  assert.match(vd, /phone_key_changed_text\(&clean_machine\(Some\(local_name\)\), old_fp\.as_deref\(\), &crate::device_id::fp_grouped\(&to_pub\)\)/)
  assert.doesNotMatch(vd, /phone_key_changed_text\(&machine/, '不用後台這次給的名字')
  assert.match(vd, /v\["confirmed"\]/)
  assert.doesNotMatch(vd.split('pub fn started_view_json')[1].split('\n}\n')[0], /fp/, '開始資料不帶指紋')
  const lib = read('../src-tauri/src/lib.rs')
  const phone = lib.slice(lib.indexOf('#[cfg(not(desktop))]\n    let builder = builder.invoke_handler('))
  for (const c of ['android_known_list', 'android_known_challenge', 'android_known_answer', 'android_known_confirm', 'android_known_forget']) assert.ok(phone.includes(`android::${c}`), c)
  const desk = lib.slice(lib.indexOf('generate_handler!['), lib.indexOf('#[cfg(not(desktop))]\n    let builder = builder.invoke_handler('))
  for (const c of ['android_known_list', 'android_known_challenge', 'android_known_answer', 'android_known_confirm', 'android_known_forget']) assert.ok(!desk.includes(c), `電腦版沒有 ${c}`)
  const rs = read('../src-tauri/src/android.rs')
  assert.doesNotMatch(rs, /Scope::Input/)
})

test('兩端給人核對的指紋一樣：電腦版設定頁回完整 16 碼，手機與電腦都每 4 個一組顯示', async () => {
  const lib = read('../src-tauri/src/lib.rs')
  const own = lib.slice(lib.indexOf('async fn device_own_fingerprint('), lib.indexOf('async fn device_own_fingerprint(') + 400)
  assert.match(own, /device_id::fingerprint\(&k\.public_b64\(\)\)/, '電腦版回完整指紋')
  assert.doesNotMatch(own.split('\n}')[0], /fp8\(/, '不是只有前 8 碼')
  const desk = await import('../ui/lib/known-peers.mjs')
  for (const fp of ['0123456789abcdef', 'a93cc5191f2e3b4d']) {
    assert.equal(desk.groupFp(fp), groupFp(fp), '兩端分組寫法一樣')
    assert.equal(groupFp(fp).replace(/ /g, ''), fp, '顯示的是完整 16 碼')
    assert.equal(desk.TEXT.ownFp(fp), `這台電腦的指紋：${groupFp(fp)}`)
  }
})

test('守門：四選一的答案、選項不進日誌、事件；畫面層不讀沒確認電腦的指紋', () => {
  const kp = read('../src-tauri/src/known_pick.rs').split('\n#[cfg(test)]')[0]
  assert.doesNotMatch(kp, /elog!|println!|emit|ui_log|tracing::|log::/)
  const rs = read('../src-tauri/src/android.rs')
  const fnBody = n => rs.slice(rs.indexOf(`pub fn ${n}(`)).split('\n}\n')[0]
  for (const n of ['android_known_challenge', 'android_known_answer', 'android_known_confirm']) assert.doesNotMatch(fnBody(n), /emit|ui_log|println!|dbg!|tracing::|log::/, n)
  assert.doesNotMatch(fnBody('android_known_challenge'), /elog!/)
  assert.doesNotMatch(fnBody('android_known_confirm'), /elog!/)
  assert.equal((fnBody('android_known_answer').match(/elog!/g) ?? []).length, 1)
  assert.match(fnBody('android_known_answer'), /elog!\("本人表示手機上的指紋選項都和電腦不一樣，沒有記住"\)/)
  assert.doesNotMatch(fnBody('android_known_confirm'), /fp:/, '確認不收指紋')
  for (const f of ['../ui/m.js', '../ui/lib/mobile-known-peers.mjs']) assert.doesNotMatch(read(f), /console\.\w+\([^)]*(options|\.ch\b|pick|answer)/, `${f} 不把選項、答案寫進 console`)
  const ui = ['../ui/m.js', '../ui/m.html', '../ui/lib/mobile-known-peers.mjs'].map(read).join('\n')
  assert.doesNotMatch(ui, /\.fp8\b|started\??\.fp\b/, '畫面層不讀沒確認電腦的指紋')
})
