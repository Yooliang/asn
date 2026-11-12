// 手機確認電腦的指紋、設定頁「認得的電腦」：文字、整理資料、確認與忘記前先過本人確認
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { TEXT, NAME_MAX, fpSuffix, groupFp, makeKnownPeers, needsConfirm, normalizeList, peerOf, errorText, renameErrorText } from '../ui/lib/mobile-known-peers.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const FP = '0123456789abcdef'

test('文字：頂端條、浮層、按鈕都是繁體中文，名字和指紋照規格放進去', () => {
  assert.equal(TEXT.stripTitle, '這台還沒確認指紋')
  assert.equal(TEXT.stripButton, '確認指紋')
  assert.equal(TEXT.sheetTitle('工作機'), '確認「工作機」的指紋')
  assert.equal(TEXT.sheetBody, '請看那台電腦的設定頁，選出和那裡顯示的「這台電腦的指紋」完全一樣的那一組。')
  assert.equal(TEXT.noneOption, '都不一樣')
  assert.equal(TEXT.cancel, '取消')
  assert.equal(TEXT.wrong, '選的和電腦上顯示的不一樣，這次沒有記住。10 分鐘後才能再確認。')
  assert.equal(TEXT.locked(7), '答錯過一次，請 7 分鐘後再確認。')
  assert.equal(TEXT.blocked, '這台的指紋兩次對不上，可能被換過。請到設定 → 設備，開那台的「詳情」按「忘記這台」，再重新連線。')
  assert.equal(TEXT.noneMatch, '這台電腦的金鑰可能被換過，請不要記住，並告訴管理的人。要到設定 → 設備，開那台的「詳情」按「忘記這台」，才能重新確認。')
  assert.equal(TEXT.expired, '太久沒選，請重新按「確認指紋」。')
  assert.equal(TEXT.forget, '忘記')
  assert.equal(TEXT.confirmed, '已確認')
  assert.equal(TEXT.unconfirmed, '未確認')
  assert.equal(TEXT.tagConfirmed, '已確認')
  assert.equal(TEXT.tagUnconfirmed, '未確認')
  assert.equal(TEXT.firstSeen('今天'), '第一次見到：今天')
  assert.equal(TEXT.neverSeen, '還沒連線過，連上時會記住指紋')
  assert.equal(TEXT.forgetThis, '忘記這台')
  assert.equal(TEXT.oldTitle(2), '舊設備紀錄（2）')
  assert.equal(TEXT.renameHint, '所有設備都會顯示這個名字')
  assert.equal(TEXT.ownNameLabel, '這支手機的名字')
  assert.deepEqual([TEXT.moveUp, TEXT.moveDown, TEXT.accounts, TEXT.detail], ['上移', '下移', '帳號', '詳情'])
  assert.equal(TEXT.fp('0123 4567 89ab cdef'), '指紋 0123 4567 89ab cdef')
  assert.equal(groupFp('0123456789abcdef'), '0123 4567 89ab cdef', '核對用完整 16 碼分組')
  assert.equal(groupFp('01234567'), '')
  assert.equal(groupFp(null), '')
  for (const t of Object.values(TEXT).map(x => (typeof x === 'function' ? x('示範', '01234567') : x))) assert.doesNotMatch(t.replace(/QR code|ASN/g, ''), /[A-Za-z]{3,}/, t)
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
  const raw = { peers: [{ node: 'a', name: '甲\n機', confirmed: true, sign_pub: 'SECRET', fp: FP, first_seen_ms: 1700000000000 }, { node: 'b', name: '乙', confirmed: false, fp: 'abcdef0123456789', fp8: 'abcdef01' }, { name: 'x' }, { node: 'c', confirmed: true, fp: 'zz' }] }
  const l = normalizeList(raw)
  assert.deepEqual(l, [{ node: 'a', name: '甲 機', label: '甲 機', fpShow: '0123 4567 89ab cdef', confirmed: true, firstSeen: new Date(1700000000000).toLocaleString('zh-TW', { hour12: false }) }, { node: 'b', name: '乙', label: '乙', fpShow: '', confirmed: false, firstSeen: '' }, { node: 'c', name: '', label: '未命名的電腦', fpShow: '', confirmed: true, firstSeen: '' }])
  assert.equal(NAME_MAX, 40)
  assert.equal(normalizeList({ peers: [{ node: 'z', name: '長'.repeat(50) }] })[0].name.length, 40, '名字最多 40 字（和後台一致）')
  assert.doesNotMatch(JSON.stringify(l), /SECRET|abcd/)
  assert.deepEqual(normalizeList(null), [])
})

test('errorText：只顯示白話，不洩漏內部訊息', () => {
  assert.equal(errorText(new Error('boom /data/user/0/x')), TEXT.failed)
  assert.match(errorText(new Error('這支手機沒有設定螢幕鎖，請先設定再操作')), /螢幕鎖/)
})

const TOKEN = 'ab'.repeat(32)

function fake(result, answers = {}) {
  const calls = []
  const api = makeKnownPeers({
    confirm: async ch => { calls.push(['confirm', ch]); return result },
    invoke: async (cmd, args) => { calls.push([cmd, args]); if (answers[cmd] instanceof Error) throw answers[cmd]; if (cmd === 'android_known_token' && !(cmd in answers)) return TOKEN; return cmd in answers ? answers[cmd] : true },
  })
  return { api, calls }
}

const OPTS = ['a93c c519 1f2e 3b4d', '1111 2222 3333 4444', '5555 6666 7777 8888', '9999 aaaa bbbb cccc']
const names = calls => calls.map(c => (Array.isArray(c) ? c[0] : c))
const TOK = ['android_known_token', { action: 'confirm', node: 'pc' }]

test('出題：答錯過一次回鎖住（帶分鐘）、答錯兩次回擋住；沒有狀態、狀態不認得就是 null；鎖住與擋住的回覆不帶選項', async () => {
  let f = fake('ok', { android_known_challenge: { state: 'locked', minutes: 7, options: OPTS, id: 'q1' } })
  assert.deepEqual(await f.api.challenge({ node: 'pc' }), { state: 'locked', minutes: 7 })
  f = fake('ok', { android_known_challenge: { state: 'locked' } })
  assert.deepEqual(await f.api.challenge({ node: 'pc' }), { state: 'locked', minutes: 10 }, '分鐘不對就用 10')
  f = fake('ok', { android_known_challenge: { state: 'blocked', options: OPTS, id: 'q1' } })
  assert.deepEqual(await f.api.challenge({ node: 'pc' }), { state: 'blocked' })
  for (const bad of [{ id: 'q1', options: OPTS }, { state: 'weird' }, null]) {
    f = fake('ok', { android_known_challenge: bad })
    assert.equal(await f.api.challenge({ node: 'pc' }), null)
  }
})

test('出題：只帶節點，回狀態、題目編號與四個分組選項；格式不對或那台沒記住就是 null', async () => {
  let f = fake('ok', { android_known_challenge: { state: 'ok', id: 'q1', options: OPTS } })
  assert.deepEqual(await f.api.challenge({ node: 'pc' }), { state: 'ok', id: 'q1', options: OPTS, localName: null })
  assert.deepEqual(f.calls, [['android_known_challenge', { node: 'pc' }]], '不用先過本人確認、不帶指紋')
  f = fake('ok', { android_known_challenge: { state: 'ok', id: 'q1', options: OPTS.slice(0, 3) } })
  assert.equal(await f.api.challenge({ node: 'pc' }), null)
  f = fake('ok', { android_known_challenge: { state: 'ok', id: 'q1', options: [...OPTS.slice(0, 3), '<b>x</b>'] } })
  assert.equal(await f.api.challenge({ node: 'pc' }), null)
  f = fake('ok', { android_known_challenge: new Error('not_ready') })
  assert.equal(await f.api.challenge({ node: 'pc' }), null)
  f = fake('ok', { android_known_challenge: new Error('boom') })
  await assert.rejects(() => f.api.challenge({ node: 'pc' }), /boom/)
  assert.equal(await fake('ok').api.challenge(null), null)
})

test('選對：先 android_known_answer，說 right 才要憑證、過本人確認，通過才叫 android_known_confirm（只帶題目編號與憑證）', async () => {
  const { api, calls } = fake('ok', { android_known_answer: 'right' })
  assert.equal(await api.pick('q1', 2, 'pc'), 'done')
  assert.deepEqual(calls, [['android_known_answer', { id: 'q1', pick: 2 }], TOK, ['confirm', TOKEN], ['android_known_confirm', { id: 'q1', challenge: TOKEN }]])
})

test('選對但本人取消、沒設螢幕鎖都不記；Rust 沒記到回 not_ready', async () => {
  let f = fake('cancel', { android_known_answer: 'right' })
  assert.equal(await f.api.pick('q1', 0, 'pc'), 'cancel')
  assert.deepEqual(names(f.calls), ['android_known_answer', 'android_known_token', 'confirm'])
  f = fake('no_lock', { android_known_answer: 'right' })
  await assert.rejects(() => f.api.pick('q1', 0, 'pc'), /螢幕鎖/)
  assert.deepEqual(names(f.calls), ['android_known_answer', 'android_known_token', 'confirm'])
  f = fake('ok', { android_known_answer: 'right', android_known_confirm: false })
  assert.equal(await f.api.pick('q1', 0, 'pc'), 'not_ready')
  f = fake('ok', { android_known_answer: 'right', android_known_token: new Error('boom') })
  await assert.rejects(() => f.api.pick('q1', 0, 'pc'), /boom/)
  assert.deepEqual(names(f.calls), ['android_known_answer', 'android_known_token'], '要不到憑證就不開生物辨識、不叫 confirm')
  f = fake('ok', { android_known_answer: 'right', android_known_token: '' })
  await assert.rejects(() => f.api.pick('q1', 0, 'pc'), /no_token/)
})

test('選錯、都不一樣、過期：不過本人確認、不叫 confirm，把 Rust 的話原樣回；-1 是都不一樣', async () => {
  for (const r of ['wrong', 'none', 'expired', 'locked', 'blocked']) {
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

test('忘記：先要憑證、過本人確認才叫 android_known_forget（帶憑證）；取消就不送', async () => {
  const FTOK = ['android_known_token', { action: 'forget', node: 'pc' }]
  let f = fake('ok')
  assert.equal(await f.api.forget('pc'), 'done')
  assert.deepEqual(f.calls, [FTOK, ['confirm', TOKEN], ['android_known_forget', { node: 'pc', challenge: TOKEN }]])
  f = fake('cancel')
  assert.equal(await f.api.forget('pc'), 'cancel')
  assert.deepEqual(f.calls, [FTOK, ['confirm', TOKEN]])
  f = fake('no_lock')
  await assert.rejects(() => f.api.forget('pc'), /螢幕鎖/)
  assert.deepEqual(f.calls, [FTOK, ['confirm', TOKEN]])
})

test('改名：走後台（android_known_rename），不用本人確認；回 { ok, name, changed }；沒有節點不送；後台的中文錯誤原樣顯示', async () => {
  let f = fake('ok', { android_known_rename: { ok: true, name: '家用機', changed: true } })
  assert.deepEqual(await f.api.rename('pc', '  家用機 '), { ok: true, name: '家用機', changed: true })
  assert.deepEqual(f.calls, [['android_known_rename', { node: 'pc', name: '家用機' }]], '不跳生物辨識、不要憑證，名字只去頭尾空白（規則由 Rust 與後台判斷）')
  f = fake('ok', { android_known_rename: { ok: true, name: 'x', changed: false } })
  assert.equal((await f.api.rename('pc', 'x')).changed, false)
  f = fake('ok', { android_known_rename: false })
  assert.equal(await f.api.rename('pc', 'x'), null)
  f = fake('ok')
  assert.equal(await f.api.rename('', 'x'), null)
  assert.deepEqual(f.calls, [])
  f = fake('ok', { android_known_rename: '改太頻繁了，請稍後再試' })
  assert.equal(await f.api.rename('pc', 'x'), null, '不是物件的回覆不當成功')
  f = makeKnownPeers({ confirm: async () => 'ok', invoke: async () => { throw '登入過期了，請重新登入' } })
  await assert.rejects(() => f.rename('pc', 'x'), e => renameErrorText(e) === '登入過期了，請重新登入')
  assert.equal(renameErrorText(new Error('boom /data/x')), TEXT.failed, '英文的內部訊息不顯示')
  assert.equal(renameErrorText('名字不合規則'), '名字不合規則')
})

test('出題帶本機記的名字：有欄位（可為空字串）就用它，沒有欄位才是 null（畫面退回原名字）', async () => {
  let f = fake('ok', { android_known_challenge: { state: 'ok', id: 'q1', options: OPTS, name: '家用機' } })
  assert.equal((await f.api.challenge({ node: 'pc' })).localName, '家用機')
  f = fake('ok', { android_known_challenge: { state: 'ok', id: 'q1', options: OPTS, name: '' } })
  assert.equal((await f.api.challenge({ node: 'pc' })).localName, '')
  f = fake('ok', { android_known_challenge: { state: 'ok', id: 'q1', options: OPTS } })
  assert.equal((await f.api.challenge({ node: 'pc' })).localName, null)
  assert.equal(TEXT.unnamed, '未命名的電腦')
  for (const k of ['rename', 'renameSave', 'renameCancel', 'renameLabel', 'renameHint']) assert.doesNotMatch(TEXT[k], /[A-Za-z]{3,}/, k)
})

test('m.html：改名表單只用文字節點與輸入框（不走 v-html）；走新的改名流程；沒名字顯示 label；浮層標題用本機名字', () => {
  const html = read('../ui/m.html')
  const info = html.slice(html.indexOf('class="m-dv-info"'), html.indexOf('<!-- /詳情 -->'))
  const own = html.slice(html.indexOf('class="m-dv-own"'), html.indexOf('<ul class="m-dv-list"'))
  for (const part of [info, own]) {
    assert.ok(part.length > 200)
    assert.doesNotMatch(part, /v-html/)
    assert.match(part, /v-model="dn\.text"/)
    assert.match(part, /:maxlength="NAME_MAX"/)
    assert.match(part, /\{\{ KNOWN_TEXT\.renameHint \}\}/)
    assert.match(part, /\{\{ dnHint \}\}/, '輸入時即時提示')
    assert.match(part, /@click="devRenameCancel">\{\{ KNOWN_TEXT\.renameCancel \}\}/)
    assert.match(part, /\{\{ KNOWN_TEXT\.renameSave \}\}/)
    assert.match(part, /\{\{ dn\.err \}\}/, '後台的錯誤顯示出來')
  }
  const js = read('../ui/m.js')
  assert.match(js, /await knownPeers\.rename\(node, dn\.text\)/)
  assert.doesNotMatch(js, /knownPeers\.rename\(node, kp\.editText\)|renameStart\(p\)|kp\.editText/, '舊的只記在手機的改名不在了')
  assert.match(js, /await Promise\.allSettled\(\[core\.refreshRoster\(\), loadKnown\(\)\]\)/, '成功後重讀名單與認得的電腦')
  assert.match(js, /dn\.err = renameErrorText\(e\)/)
  assert.match(js, /deviceNameError\(dn\.text\)/)
  assert.match(js, /vp\.sheetName = ch\.localName === null \? cur\.name : \(ch\.localName \|\| KNOWN_TEXT\.unnamed\)/)
  assert.match(js, /knownPeers\.pick\(ch\.id, index, cur\.node\)/)
})

test('m.html：這支手機的名字在設備頁最上面（設備列表之前），改名用自己的節點', () => {
  const html = read('../ui/m.html')
  const pane = html.slice(html.indexOf("acctSw.tab === 'devices'"))
  assert.ok(pane.indexOf('class="m-dv-own"') > 0 && pane.indexOf('class="m-dv-own"') < pane.indexOf('class="m-dv-list"'))
  const own = pane.slice(pane.indexOf('class="m-dv-own"'), pane.indexOf('class="m-dv-list"'))
  assert.match(own, /\{\{ KNOWN_TEXT\.ownNameLabel \}\}/)
  assert.match(own, /\{\{ selfDev \? selfDev\.label : '' \}\}/, '顯示後台記的名字（自己那一列的名字）')
  assert.match(own, /dn\.node !== info\.node/)
  assert.match(own, /v-if="dn\.node === info\.node"/, '用這支手機自己的節點改名')
  assert.match(own, /@click="devRenameStart\(selfDev\)">\{\{ KNOWN_TEXT\.rename \}\}/)
  assert.match(read('../ui/m.js'), /const selfDev = computed\(\(\) => acctAllDevs\.value\.find\(d => d\.self\) \?\? null\)/)
})

test('m.html：設備列每列剛好 4 顆操作按鈕（上移、下移、帳號、詳情）；有認得紀錄的電腦標「已確認」或「未確認」（文字，不只靠顏色）', () => {
  const html = read('../ui/m.html')
  const row = html.slice(html.indexOf('<li v-for="d in acctDevs"'), html.indexOf('</li>', html.indexOf('<li v-for="d in acctDevs"')))
  const group = row.slice(row.indexOf('class="m-dv-btns m-dv-rowbtns"'))
  assert.equal((group.match(/<button /g) ?? []).length, 4)
  const labels = [...group.matchAll(/\{\{ KNOWN_TEXT\.(\w+) \}\}<\/button>/g)].map(m => m[1])
  assert.deepEqual(labels, ['moveUp', 'moveDown', 'accounts', 'detail'])
  assert.match(row, /@click="acctMove\(d\.key, -1\)"/)
  assert.match(row, /@click="acctMove\(d\.key, 1\)"/)
  assert.match(row, /class="m-dv-grip"/, '排序把手還在')
  assert.match(row, /joined\.byNode\[d\.key\]\.confirmed">\{\{ KNOWN_TEXT\.tagConfirmed \}\}/)
  assert.match(row, /v-else-if="!d\.self && joined\.byNode\[d\.key\]">\{\{ KNOWN_TEXT\.tagUnconfirmed \}\}/)
  assert.doesNotMatch(row, /fpShow|\.fp\b/, '列上不顯示指紋')
  assert.match(html, /v-if="joined\.old\.length"/)
})

test('m.html：詳情——指紋只有確認過的才畫；沒確認只有「還沒確認」與確認按鈕；沒紀錄的電腦說還沒連線過；忘記這台；不走 v-html', () => {
  const html = read('../ui/m.html')
  const info = html.slice(html.indexOf('class="m-dv-info"'), html.indexOf('<!-- /詳情 -->'))
  assert.doesNotMatch(info, /v-html/)
  const fpRefs = [...info.matchAll(/fpShow/g)].length
  assert.equal(fpRefs, 2, '指紋只出現在「已確認」那一段（判斷＋顯示）')
  const confirmedBranch = /v-else-if="curKnown && curKnown\.confirmed"[\s\S]*?<\/p>/.exec(info)[0]
  assert.match(confirmedBranch, /curKnown\.fpShow/)
  const unconfirmedBranch = /v-else-if="curKnown"><span[\s\S]*?<\/p>/.exec(info)[0]
  assert.doesNotMatch(unconfirmedBranch, /fp/i, '沒確認的不顯示也不碰指紋')
  assert.match(unconfirmedBranch, /v-if="!curKnown\.confirmed"[^>]*@click="confirmKnown\(curKnown\)">\{\{ KNOWN_TEXT\.confirmButton \}\}/, '確認按鈕只在沒確認時出現')
  assert.equal((info.match(/confirmKnown\(/g) ?? []).length, 1)
  assert.match(info, /\{\{ KNOWN_TEXT\.neverSeen \}\}/)
  assert.match(info, /\{\{ KNOWN_TEXT\.firstSeen\(curKnown\.firstSeen\) \}\}/)
  assert.match(info, /@click="forgetKnown\(curKnown\.node\)">\{\{ KNOWN_TEXT\.forgetThis \}\}/)
  assert.match(info, /acctCanRemove/, '隱藏與永久移除也在詳情')
  assert.ok(info.indexOf('curKnown.firstSeen') < info.indexOf('forgetKnown('), '忘記這台在最下面')
  assert.match(info, /<template v-if="acctCur\.self"><\/template>/, '手機自己沒有可顯示的指紋命令，不顯示')
  const old = html.slice(html.indexOf('class="m-dv-old"'), html.indexOf('<!-- /舊設備紀錄 -->'))
  assert.doesNotMatch(old, /v-html/)
  assert.match(old, /<b>\{\{ p\.label \}\}<\/b>/)
  assert.match(old, /v-if="p\.confirmed && p\.fpShow"/, '舊紀錄的指紋也只有確認過的才畫')
  assert.doesNotMatch(old, /confirmKnown/, '舊紀錄只能忘記')
  assert.match(old, /@click="forgetKnown\(p\.node\)">\{\{ KNOWN_TEXT\.forget \}\}/)
  assert.doesNotMatch(html, /settingCat === 'known'/)
})

test('守門：android_known_confirm／forget 前一定先 gate（要憑證、過本人確認）；先回答、再本人確認、最後才記住；只有 mobile-known-peers.mjs 叫這些命令', () => {
  const src = read('../ui/lib/mobile-known-peers.mjs')
  for (const cmd of ['android_known_confirm', 'android_known_forget']) {
    const i = src.indexOf(`'${cmd}'`)
    assert.ok(i > 0)
    const start = Math.max(src.lastIndexOf('pick:', i), src.lastIndexOf('forget:', i))
    assert.ok(src.slice(start, i).includes('await gate('), `${cmd} 前要先過本人確認`)
    assert.ok(src.slice(i, i + 80).includes('challenge'), `${cmd} 要帶憑證`)
  }
  const pick = src.slice(src.indexOf('pick: async'))
  assert.ok(pick.indexOf("'android_known_answer'") < pick.indexOf('await gate(') && pick.indexOf('await gate(') < pick.indexOf("'android_known_confirm'"), '順序')
  const gate = src.slice(src.indexOf('const gate = async'), src.indexOf('return {\n    list:'))
  assert.ok(gate.indexOf("'android_known_token'") < gate.indexOf('await confirm('), '先要憑證才開本人確認')
  assert.match(src, /import \{ confirmWithToken, scanFingerprint \} from '\.\/mobile-confirm\.mjs'/)
  assert.doesNotMatch(src, /confirmViewer/, '不用沒有憑證的那種')
  assert.doesNotMatch(src, /remember|{ node: peer.node, fp/, '不再有「記住這台」、不送指紋')
  for (const f of ['../ui/m.js', '../ui/m.html', '../ui/lib/mobile-remote-view.mjs', '../ui/lib/term-remote.mjs', '../ui/lib/chatpane.mjs']) {
    assert.doesNotMatch(read(f), /android_known_(challenge|answer|confirm|forget)/, `${f} 不直接叫`)
  }
  assert.doesNotMatch(read('../ui/m.js'), /invoke\('android_known_/)
  assert.doesNotMatch(read('../ui/m.js'), /android_known_token/, '憑證只在 mobile-known-peers.mjs 裡要、用')
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
  assert.match(html, /v-if="chatFriend && vp\.note && !vp\.noteOwn"[^>]*>\{\{ vp\.note \}\}/)
  assert.match(html, /v-if="chatFriend && peerStrip"/)
  assert.match(html, /@click="openMethodSheet">\{\{ KNOWN_TEXT\.stripButton \}\}/)
  assert.match(html, /@remote-started="onRemoteStarted" @remote-ended="onRemoteEnded"/)
  assert.match(html, /@click="forgetKnown\(curKnown\.node\)">\{\{ KNOWN_TEXT\.forgetThis \}\}/)
  const js = read('../ui/m.js')
  assert.match(js, /knownPeers\.challenge\(cur\)/)
  assert.match(js, /knownPeers\.pick\(ch\.id, index, cur\.node\)/)
  assert.match(js, /knownPeers\.forget\(node\)/)
  for (const k of ['wrong', 'none', 'expired', 'locked', 'blocked']) assert.match(js, new RegExp(`${k}: KNOWN_TEXT\\.`))
  assert.match(js, /ch\.state === 'locked'\) vp\.note = KNOWN_TEXT\.locked\(ch\.minutes\)/)
  assert.match(js, /ch\.state === 'blocked'\) vp\.note = KNOWN_TEXT\.blocked/)
  assert.doesNotMatch(sheet, /minutes|state/, '浮層只有選項，不看狀態')
})

test('chatpane／RemoteView 把開始與結束交給手機畫面；開始時帶上那台的名字', () => {
  const tr = read('../ui/lib/term-remote.mjs')
  assert.match(tr, /emit\('started', \{ \.\.\.r, machine: props\.machine \|\| props\.node \}\)/)
  assert.match(tr, /emits: \['cancel', 'status', 'started', 'ended'\]/)
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
  // 手機也能打字（#1378）：android.rs 只用範圍檢查打字的上限；要先確認過那台的指紋，判斷在共用核心（view_d），指紋不經過畫面
  assert.equal(rs.split('\n').filter(l => l.includes('Scope::Input')).length, 1)
  assert.match(rs, /if sc == crate::view_handshake::Scope::Input && !crate::consent::label_ok\(window\.label\(\)\) \{/)
  assert.match(vd, /if phone && scope == Scope::Input && !crate::device_id::phone_input_allowed\(/)
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

// ---- 掃電腦畫面上的 QR code 核對指紋：畫面只拿得到狀態字，拿不到掃到的字 ----

test('掃 QR code 的文字：照規格、繁體中文', () => {
  assert.equal(TEXT.scanButton, '用相機掃電腦上的 QR code')
  assert.equal(TEXT.scanFallback, '沒辦法掃，改用選的')
  assert.equal(TEXT.scanMismatch, '掃到的指紋和這支手機記住的不一樣，可能被換過，已經擋下。請到設定 → 設備，開那台的「詳情」按「忘記這台」，再重新連線。')
  assert.equal(TEXT.scanBad, '這不是 ASN 的指紋 QR code，請掃電腦設定頁上的那個。')
  assert.equal(TEXT.scanNoCamera, '沒辦法用相機，改用選的。')
  assert.match(TEXT.methodBody, /顯示 QR code/)
})

function fakeScan(status, answers = {}) {
  const calls = []
  const api = makeKnownPeers({
    confirm: async ch => { calls.push(['confirm', ch]); return 'ok' },
    scan: async ch => { calls.push(['scan', ch]); return status },
    invoke: async (cmd, args) => { calls.push([cmd, args]); if (answers[cmd] instanceof Error) throw answers[cmd]; if (cmd === 'android_known_token' && !(cmd in answers)) return TOKEN; return cmd in answers ? answers[cmd] : 'ok' },
  })
  return { api, calls }
}
const STOK = ['android_known_token', { action: 'scan', node: 'pc' }]

test('掃描：先要 scan 憑證、外殼掃並過本人確認，通過才叫 android_known_scan_confirm（只帶節點與憑證）', async () => {
  const { api, calls } = fakeScan('ok')
  assert.equal(await api.scan('pc'), 'done')
  assert.deepEqual(calls, [STOK, ['scan', TOKEN], ['android_known_scan_confirm', { node: 'pc', challenge: TOKEN }]])
  assert.equal(await fakeScan('ok').api.scan(''), 'cancel')
})

test('掃描：取消、沒相機、被拒、掃到的不是 ASN 的（外殼說的）都不叫 Rust 判斷', async () => {
  for (const [st, want] of [['cancel', 'cancel'], ['denied', 'no_camera'], ['no_camera', 'no_camera'], ['bad_qr', 'bad_qr'], ['weird', 'cancel']]) {
    const f = fakeScan(st)
    assert.equal(await f.api.scan('pc'), want, st)
    assert.deepEqual(f.calls, [STOK, ['scan', TOKEN]], st)
  }
  await assert.rejects(() => fakeScan('no_lock').api.scan('pc'), /螢幕鎖/)
})

test('掃描：Rust 的判斷原樣對應；被擋住或鎖住的不開相機；不認得的回覆丟錯', async () => {
  for (const [out, want] of [['ok', 'done'], ['mismatch', 'mismatch'], ['bad_qr', 'bad_qr'], ['blocked', 'blocked'], ['locked', 'locked'], ['not_verified', 'not_ready']]) {
    assert.equal(await fakeScan('ok', { android_known_scan_confirm: out }).api.scan('pc'), want, out)
  }
  await assert.rejects(() => fakeScan('ok', { android_known_scan_confirm: 'weird' }).api.scan('pc'), /unexpected/)
  await assert.rejects(() => fakeScan('ok', { android_known_scan_confirm: true }).api.scan('pc'), /unexpected/, '只認得字串狀態')
  for (const e of ['blocked', 'locked', 'not_ready']) {
    const f = fakeScan('ok', { android_known_token: new Error(e) })
    assert.equal(await f.api.scan('pc'), e)
    assert.deepEqual(f.calls, [STOK], '要不到憑證就不開相機')
  }
  await assert.rejects(() => fakeScan('ok', { android_known_token: new Error('boom') }).api.scan('pc'), /boom/)
  await assert.rejects(() => fakeScan('ok', { android_known_token: '' }).api.scan('pc'), /no_token/)
})

test('守門：掃到的字不經過網頁——橋只回狀態字、Rust 命令只收節點與憑證、畫面沒有任何讀掃描內容的地方', async () => {
  const mc = read('../ui/lib/mobile-confirm.mjs')
  assert.match(mc, /const SCAN_RESULTS = \[\.\.\.RESULTS, 'denied', 'no_camera', 'bad_qr'\]/)
  assert.match(mc, /resolve\(allowed\.includes\(r\) \? r : 'cancel'\)/, '外殼回什麼字都先過白名單，不在名單內一律 cancel')
  const kp = read('../ui/lib/mobile-known-peers.mjs')
  assert.match(kp, /invoke\('android_known_scan_confirm', \{ node, challenge \}\)/, '只帶節點與憑證')
  assert.equal((kp.match(/invoke\('android_known_scan_confirm'/g) ?? []).length, 1, '只有 scan 那一處叫')
  const scanFn = kp.slice(kp.indexOf('scan: async node'), kp.indexOf('/** 替這台改名'))
  assert.doesNotMatch(scanFn, /scanText|\.text\b|decoded|JSON\.parse/, '沒有任何讀掃描內容的寫法')
  // 外殼的橋收（回呼編號、憑證），不回傳字串
  const { scanFingerprint } = await import('../ui/lib/mobile-confirm.mjs')
  const win = { AsnAndroid: { scanFingerprint(id, ch) { this.got = [id, ch]; setTimeout(() => win.__asnConfirmViewer(id, 'ok'), 0) } } }
  assert.equal(await scanFingerprint('ab'.repeat(32), win), 'ok')
  assert.equal(win.AsnAndroid.got[1], 'ab'.repeat(32))
  assert.equal(await scanFingerprint('壞的', win), 'cancel', '憑證格式不對不送')
  const bad = { AsnAndroid: { scanFingerprint(id) { setTimeout(() => bad.__asnConfirmViewer(id, 'asn-fp:v1:pc:0123456789abcdef'), 0) } } }
  assert.equal(await scanFingerprint('ab'.repeat(32), bad), 'cancel', '就算外殼回了一段字，也不當結果、不往下傳')
  assert.equal(await scanFingerprint('ab'.repeat(32), {}), 'cancel', '沒有外殼＝取消')
  for (const st of ['denied', 'no_camera', 'bad_qr', 'no_lock', 'cancel']) {
    const w = { AsnAndroid: { scanFingerprint(id) { setTimeout(() => w.__asnConfirmViewer(id, st), 0) } } }
    assert.equal(await scanFingerprint('ab'.repeat(32), w), st)
  }
  // 查看終端與記住的確認，不接受掃描專用的狀態字
  const { confirmWithToken } = await import('../ui/lib/mobile-confirm.mjs')
  const w2 = { AsnAndroid: { confirmWithToken(id) { setTimeout(() => w2.__asnConfirmViewer(id, 'denied'), 0) } } }
  assert.equal(await confirmWithToken('ab'.repeat(32), w2), 'cancel')
  const js = read('../ui/m.js')
  assert.doesNotMatch(js, /scanFingerprint|android_known_scan|AsnAndroid/, 'm.js 只透過 mobile-known-peers.mjs')
})

test('m.html：選方法的浮層只用文字節點；掃描是主要按鈕、改用選的接到原本的四選一；結果說明放在條下面', () => {
  const html = read('../ui/m.html')
  const sheet = html.slice(html.indexOf('v-if="vp.method && vp.cur && !vp.sheet"'), html.indexOf('v-if="vp.sheet && vp.cur && vp.ch"'))
  assert.ok(sheet.length > 100)
  assert.doesNotMatch(sheet, /v-html|innerHTML/)
  assert.match(sheet, /class="m-btn m-btn-big"[^>]*@click="scanPeer">\{\{ KNOWN_TEXT\.scanButton \}\}/)
  assert.match(sheet, /@click="methodPickInstead">\{\{ KNOWN_TEXT\.scanFallback \}\}/)
  assert.match(sheet, /@click="closeMethodSheet">\{\{ KNOWN_TEXT\.cancel \}\}/)
  const js = read('../ui/m.js')
  assert.match(js, /knownPeers\.scan\(cur\.node\)/)
  for (const k of ['mismatch', 'bad_qr']) assert.match(js, new RegExp(`${k}: KNOWN_TEXT\.scan`))
  assert.match(js, /KNOWN_TEXT\.scanNoCamera/)
  assert.match(js, /const methodPickInstead = async \(\) => \{ vp\.method = false; await openPeerSheet\(\) \}/)
  assert.doesNotMatch(js, /console\.\w+\([^)]*(scan\w*Text|decoded)/)
})

test('詳情的確認：只有還沒確認的才有「確認」按鈕，按下去走和提示條同一個開浮層的入口', () => {
  assert.equal(TEXT.confirmButton, '確認')
  const html = read('../ui/m.html')
  const info = html.slice(html.indexOf('class="m-dv-info"'), html.indexOf('<!-- /詳情 -->'))
  assert.match(info, /v-if="!curKnown\.confirmed"[^>]*@click="confirmKnown\(curKnown\)">\{\{ KNOWN_TEXT\.confirmButton \}\}/, '未確認者才有確認按鈕')
  assert.equal((info.match(/confirmKnown\(curKnown\)/g) ?? []).length, 1)
  assert.doesNotMatch(html.slice(html.indexOf('class="m-dv-old"'), html.indexOf('<!-- /舊設備紀錄 -->')), /confirmKnown/)
  // 提示條與詳情按鈕最後都開同一個選方法浮層（openMethodSheet）
  assert.match(html, /class="m-btn m-peer-strip-btn" type="button" @click="openMethodSheet"/)
  const js = read('../ui/m.js')
  assert.match(js, /const confirmKnown = p => \{[^\n]*openMethodSheet\(\)[^\n]* \}/, '詳情的確認呼叫同一個 openMethodSheet')
  assert.match(js, /if \(!p\?\.node \|\| p\.confirmed/, '已確認的不處理')
  assert.doesNotMatch(js, /confirmKnown[^\n]*android_known/, '不另寫一套確認流程')
})

test('設定頁開確認：先暫存原本正在看的電腦，所有出口（成功、取消、失敗）收掉後統一還原；提示條路徑不受影響', () => {
  const js = read('../ui/m.js')
  assert.match(js, /const prev = vpPrev \?\? \{ cur: vp\.cur \}; vpReset\(\); vpPrev = prev;/, '開之前先記下原本的對象')
  assert.match(js, /watch\(\(\) => !vp\.method && !vp\.sheet && !vp\.busy, idle => \{ if \(idle && vpPrev\) \{ vp\.cur = vpPrev\.cur; vpPrev = null \} \}\)/, '全部收掉後統一還原')
  assert.match(js, /const vpReset = \(\) => \{ vpPrev = null;/, '開始／結束看電腦時作廢暫存')
  // 提示條的入口不碰暫存；暫存只在 confirmKnown 設
  assert.equal((js.match(/vpPrev = prev/g) ?? []).length, 1)
  const strip = js.slice(js.indexOf('const openMethodSheet'), js.indexOf('const markConfirmed'))
  assert.doesNotMatch(strip, /vpPrev/)
})

test('還原邏輯（模擬）：A 在看，從設定頁確認 B，成功、取消、失敗收掉後 A 都回來；沒暫存時不動', () => {
  for (const exit of ['done', 'cancel', 'fail']) {
    const vp = { cur: { node: 'A' }, method: false, sheet: false, busy: false }
    let vpPrev = null
    const idleCheck = () => { if (!vp.method && !vp.sheet && !vp.busy && vpPrev) { vp.cur = vpPrev.cur; vpPrev = null } }
    vpPrev = { cur: vp.cur }; vp.cur = { node: 'B' }; vp.method = true; idleCheck()
    assert.equal(vp.cur.node, 'B', '確認中維持 B')
    if (exit === 'done') vp.cur = { node: 'B', confirmed: true }
    vp.method = false; idleCheck()
    assert.equal(vp.cur.node, 'A', exit)
  }
  const vp = { cur: { node: 'C' }, method: false, sheet: false, busy: false }
  const vpPrev = null
  if (!vp.method && !vp.sheet && !vp.busy && vpPrev) vp.cur = null
  assert.equal(vp.cur.node, 'C', '提示條路徑不動')
})

test('詳情確認留下的提示：成功路徑已清；離開或重進詳情時只清詳情開的那種，終端提示條的不碰', () => {
  const js = read('../ui/m.js')
  assert.match(js, /if \(r === 'done'\) \{[^\n]*vp\.note = ''/, '掃描成功清提示')
  assert.match(js, /if \(r === 'done'\) \{ markConfirmed\(cur\); vp\.note = ''/, '四選一成功清提示')
  assert.match(js, /openMethodSheet\(\); vp\.noteOwn = true \}/, '只有設定頁的確認標記為自己的提示')
  assert.match(js, /const openMethodSheet = \(\) => \{ if \(!vp\.cur \|\| vp\.busy\) return; vp\.noteOwn = false;/, '提示條開的確認取消標記')
  assert.match(js, /const vpReset = \(\) => \{ vpPrev = null; vp\.noteOwn = false;/, '開始／結束看電腦取消標記')
  assert.match(js, /watch\(\(\) => acctSw\.page === 'detail' && acctSw\.sub === 'info', \(now, was\) => \{ if \(now !== was\) \{ if \(vp\.noteOwn\) \{ vp\.note = ''; vp\.noteOwn = false \}/, '離開或重進詳情才清、且只清自己的')
})

test('設定頁確認的就是正在看的那台：成功後原本對象一併標已確認（還原後提示條不再跳出）；失敗提示只在設定頁顯示', () => {
  const js = read('../ui/m.js')
  assert.match(js, /const markConfirmed = cur => \{ if \(vp\.cur === cur\) vp\.cur = \{ \.\.\.cur, confirmed: true \}; if \(vpPrev\?\.cur\?\.node === cur\.node\) vpPrev = \{ cur: \{ \.\.\.vpPrev\.cur, confirmed: true \} \} \}/)
  assert.equal((js.match(/markConfirmed\(cur\)/g) ?? []).length, 2, '掃描與四選一兩條成功路徑都走同一處')
  // 模擬：A 在看（未確認），設定頁確認 A 成功，還原後仍是已確認；確認別台 B 則還原成原樣的 A
  const run = confirmNode => {
    const A = { node: 'A', confirmed: false }, B = { node: confirmNode, confirmed: false }
    const vp = { cur: B }
    let vpPrev = { cur: A }
    const markConfirmed = cur => { if (vp.cur === cur) vp.cur = { ...cur, confirmed: true }; if (vpPrev?.cur?.node === cur.node) vpPrev = { cur: { ...vpPrev.cur, confirmed: true } } }
    markConfirmed(B)
    vp.cur = vpPrev.cur
    return vp.cur
  }
  assert.equal(run('A').confirmed, true)
  assert.equal(run('B').confirmed, false)
  const html = read('../ui/m.html')
  assert.match(html, /v-if="chatFriend && vp\.note && !vp\.noteOwn"/, '終端提示條不顯示設定頁的提示')
  assert.match(html, /v-if="vp\.note && vp\.noteOwn" role="alert"/, '設定頁只顯示自己的提示')
})

test('#1393 審查：改名沒拿到成功回覆要顯示失敗、名單沒讀到不全歸舊紀錄、提示字改新位置、像指紋的名字當未命名', async () => {
  const js = fs.readFileSync(new URL('../ui/m.js', import.meta.url), 'utf8')
  assert.match(js, /const r = await knownPeers\.rename\(node, dn\.text\)\s*if \(!r\) \{ dn\.err = KNOWN_TEXT\.failed; return \}/)
  assert.match(js, /return acctAllDevs\.value\.length \? j : \{ \.\.\.j, old: \[\] \}/)
  const { LOGIN_TEXT } = await import('../ui/lib/mobile-device-login.mjs')
  assert.ok(LOGIN_TEXT.confirmNeed.includes('「設定 → 設備」') && !LOGIN_TEXT.confirmNeed.includes('認得的電腦'))
  const { normalizeList } = await import('../ui/lib/mobile-known-peers.mjs')
  assert.equal(normalizeList({ peers: [{ node: 'pc', name: '工作機 a93cc519', confirmed: false }] })[0].label, '未命名的電腦')
})
