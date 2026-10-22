// 手機版（安卓）的純邏輯：單欄導覽、名單分組、提示規則、外殼橋、登入後的下一步。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EDGE_PX, TABS, TAB_LABEL, indicatorPos, pagerShift, swipeLock, swipeStartOk, swipeTarget, tabIndex, tabNav, SWIPE_BLOCK_SELECTOR, COMMIT_FRAC, ASN_BADGE, BACKFILL_MAX, LAST_WORDS_MAX, accountDisplayName, backfillQueue, lastWords, vendorBadgeHtml, PTR_LOADING_H, PTR_MAX, PTR_THRESHOLD, PULL_TEXT, UPDATE_LATEST, UPDATE_UNAVAILABLE, launchNav, opsNav, pullHeight, pullPhase, pullRatio, shouldRefreshOnRelease, updateCheckErrorText } from '../ui/lib/mobile.mjs'
import { BANNER_MS, DEFAULT_PREFS, MSG_VIBRATE_MS, NUDGE_VIBRATE_MS, UPDATE_CHECK_MS, afterBind, bannerText, buttonLabel, initialUpdate, installOutcome, progressText, shouldAutoCheck, withAvailable, withFailure, withProgress, androidBridge, initialNav, meNav, normalizeNav, normalizePrefs, notifyPlan, rosterGroups, savePhotoOnPhone, totalUnread } from '../ui/lib/mobile.mjs'
import { groupHeading } from '../ui/lib/tabs.mjs'

const F = (id, node, nick, status = 'online', extra = {}) => ({ id, node, agent: nick, nick, status, device: `設備${node}`, unread: 0, ...extra })

test('導覽：夥伴／對話／設置三個分頁、開新夥伴與「⋯」選單兩種浮層；瀏覽記錄裡的壞資料一律退回名單', () => {
  assert.deepEqual(initialNav(), { tab: 'list', sheet: '' })
  assert.deepEqual(meNav(), { tab: 'me', sheet: '' })
  assert.deepEqual(launchNav(), { tab: 'list', sheet: 'launch' })
  assert.deepEqual(opsNav(), { tab: 'chats', sheet: 'ops' })
  assert.deepEqual(normalizeNav({ sheet: 'launch', tab: 'me' }), launchNav())
  assert.deepEqual(normalizeNav({ sheet: 'ops', tab: 'list' }), opsNav())
  assert.deepEqual(normalizeNav({ sheet: 'other' }), initialNav())
  assert.deepEqual(normalizeNav({ tab: 'me' }), meNav())
  assert.deepEqual(normalizeNav({ chat: 'A/x', tab: 'chats' }), tabNav('chats'), '舊的對話層不再有：只留分頁')
  assert.deepEqual(normalizeNav({ tab: 'chats' }), tabNav('chats'))
  for (const bad of [null, undefined, 5, 'x', { tab: 'settings' }, { chat: 7 }, []]) assert.deepEqual(normalizeNav(bad), initialNav(), String(bad))
})

test('名單：依設備分組、本機那組在最前、組內線上在前；搜尋只留符合的；手機不依狀態或廠商分頁', () => {
  const fl = [F('B/a', 'B', '乙', 'offline'), F('B/b', 'B', '甲'), F('H/s', 'H', '小幫手'), F('H/t', 'H', '阿達', 'busy')]
  const g = rosterGroups(fl, { selfNode: 'H', selfName: '我的手機-ASN' })
  assert.deepEqual(g.map(x => x.label), ['我的手機-ASN', '設備B'], '本機第一')
  assert.deepEqual(g[1].items.map(x => x.nick), ['甲', '乙'], '線上在離線前')
  assert.equal(groupHeading(g[1]), '設備B (1/2)')
  const q = rosterGroups(fl, { query: ' 阿', selfNode: 'H', selfName: 'x' })
  assert.deepEqual(q.map(x => x.items.map(i => i.nick)), [['阿達']])
  assert.deepEqual(rosterGroups([], {}), [])
  assert.deepEqual(rosterGroups(null, {}), [])
  assert.equal(totalUnread([{ unread: 2 }, { unread: 0 }, { unread: -3 }, {}, null]), 2)
})

test('提示：只有訊息與震動會提示；正在看的對話不跳橫幅；震動預設只在對方傳震動時', () => {
  const m = id => ({ kind: 'msg', friend: { id, nick: '甲', status: 'online', hue: 10 }, line: '嗨' })
  const nd = id => ({ kind: 'nudge', friend: { id, nick: '甲', status: 'online', hue: 10 }, line: '傳送了一個震動' })
  const base = { openId: '', foreground: true, prefs: DEFAULT_PREFS }
  const a = notifyPlan(m('A'), base)
  assert.equal(a.banner.id, 'A'); assert.equal(a.banner.line, '嗨'); assert.equal(a.vibrate, 0, '一般訊息預設不震')
  assert.equal(notifyPlan(m('A'), { ...base, openId: 'A' }).banner, null, '正在看這位，不跳橫幅')
  assert.notEqual(notifyPlan(m('A'), { ...base, openId: 'B' }).banner, null, '看別人的對話，要跳')
  assert.equal(notifyPlan(m('A'), { ...base, foreground: false }).banner, null, '不在前景不跳（推播是第二期）')
  assert.equal(notifyPlan(m('A'), { ...base, prefs: { ...DEFAULT_PREFS, vibrateMsg: true } }).vibrate, MSG_VIBRATE_MS)
  assert.equal(notifyPlan(m('A'), { ...base, openId: 'A', prefs: { ...DEFAULT_PREFS, vibrateMsg: true } }).vibrate, 0, '正在看就不用再震')
  const n = notifyPlan(nd('A'), { ...base, openId: 'A' })
  assert.deepEqual([n.vibrate, n.shake, n.banner], [NUDGE_VIBRATE_MS, true, null], '正在看的對話：震動並抖一下畫面')
  const n2 = notifyPlan(nd('A'), base)
  assert.deepEqual([n2.vibrate, n2.shake, n2.banner?.id], [NUDGE_VIBRATE_MS, false, 'A'])
  assert.equal(notifyPlan(nd('A'), { ...base, prefs: { ...DEFAULT_PREFS, vibrateNudge: false } }).vibrate, 0)
  for (const k of ['login', 'weird', undefined]) assert.deepEqual(notifyPlan({ kind: k, friend: { id: 'A' } }, base), { banner: null, vibrate: 0, shake: false })
  assert.deepEqual(notifyPlan(null, base), { banner: null, vibrate: 0, shake: false })
  assert.ok(BANNER_MS >= 2000 && BANNER_MS <= 8000)
})

test('設定：壞值退回預設，震動提示預設只開對方傳來的震動', () => {
  assert.deepEqual(normalizePrefs(null), { vibrateMsg: false, vibrateNudge: true, autoUpdate: true })
  assert.deepEqual(normalizePrefs({ vibrateMsg: true, vibrateNudge: false, autoUpdate: false }), { vibrateMsg: true, vibrateNudge: false, autoUpdate: false }, '自動檢查可以關')
  assert.deepEqual(normalizePrefs({ vibrateMsg: 'yes', vibrateNudge: 0, autoUpdate: 'no' }), { vibrateMsg: false, vibrateNudge: true, autoUpdate: true }, '只認真正的布林')
})

test('外殼橋：沒有 AsnAndroid 就是 null；有的話包一層，呼叫出錯不外洩', () => {
  assert.equal(androidBridge({}), null)
  assert.equal(androidBridge(null), null)
  assert.equal(androidBridge({ AsnAndroid: { exportFile() {} } }), null, '缺 vibrate 不算外殼')
  const calls = []
  const b = androidBridge({ AsnAndroid: { vibrate: ms => calls.push(['v', ms]), exportFile: p => (calls.push(['e', p]), '下載/ASN/a.pdf'), openDownloads: () => calls.push(['o']), relaunch: () => { throw new Error('boom') } } })
  b.vibrate(300)
  assert.equal(b.exportFile('/data/x/a.pdf'), '下載/ASN/a.pdf')
  b.openDownloads()
  assert.doesNotThrow(() => b.relaunch())
  assert.deepEqual(calls, [['v', 300], ['e', '/data/x/a.pdf'], ['o']])
  const half = androidBridge({ AsnAndroid: { vibrate() {} } })
  assert.equal(half.exportFile('/x'), '', '外殼沒有這個方法＝空字串')
})

test('收到的檔案另存：外殼匯出成功回位置；沒有外殼或失敗要明講，不假裝存好了', async () => {
  const ok = androidBridge({ AsnAndroid: { vibrate() {}, exportFile: () => '下載/ASN/a.pdf' } })
  assert.equal(await savePhotoOnPhone('/data/user/0/tw.yooliang.asn/files/a.pdf', ok), '下載/ASN/a.pdf')
  assert.equal(await savePhotoOnPhone(null, ok), null, '使用者取消／沒有檔案')
  await assert.rejects(() => savePhotoOnPhone('/x/a.pdf', null), /下載/)
  const fail = androidBridge({ AsnAndroid: { vibrate() {}, exportFile: () => '' } })
  await assert.rejects(() => savePhotoOnPhone('/x/a.pdf', fail), /下載/)
})

test('登入後：新建節點要重開（有外殼自動重開），已有節點直接進名單', () => {
  const b = androidBridge({ AsnAndroid: { vibrate() {} } })
  assert.deepEqual(afterBind({ state: 'created' }, b), { action: 'relaunch' })
  const ask = afterBind({ state: 'created' }, null)
  assert.equal(ask.action, 'ask'); assert.match(ask.text, /重新打開/)
  for (const s of ['bound', 'pending', undefined]) assert.deepEqual(afterBind({ state: s }, b), { action: 'enter' })
  assert.deepEqual(afterBind(null, b), { action: 'enter' })
})

test('自動更新：發現新版 → 橫幅文字與按鈕；下載中顯示進度；失敗可重試；沒有新版或 Play 版什麼都不顯示', () => {
  let u = initialUpdate()
  assert.equal(bannerText(u), '')
  u = withAvailable(u, { enabled: true, available: true, version: '0.1.33', line: '修正登入' })
  assert.equal(u.phase, 'available'); assert.equal(bannerText(u), '有新版本 0.1.33：修正登入'); assert.equal(buttonLabel(u), '更新')
  assert.equal(bannerText({ ...u, line: '' }), '有新版本 0.1.33')
  u = withProgress(u, { done: 2_500_000, total: 10_000_000 })
  assert.equal(u.phase, 'downloading'); assert.equal(bannerText(u), '下載中 25%')
  assert.equal(progressText(5, 0), '下載中…'); assert.equal(progressText(20, 10), '下載中 100%')
  assert.equal(withAvailable(u, { enabled: true, available: false }).phase, 'downloading', '下載中查到「沒有新版」不打斷下載')
  u = withFailure(u, '下載中斷')
  assert.equal(bannerText(u), '更新失敗：下載中斷'); assert.equal(buttonLabel(u), '重試')
  assert.equal(withAvailable(initialUpdate(), { enabled: true, available: false }).phase, 'idle')
  const play = withAvailable(initialUpdate(), { enabled: false })
  assert.deepEqual([play.enabled, play.phase], [false, 'idle'], 'Play 版：Rust 回 enabled:false，畫面不出現更新')
  assert.ok(UPDATE_CHECK_MS === 6 * 3600 * 1000)
})

test('自動更新：交給系統安裝程式的各種結果；沒有許可要引導使用者；自動檢查可關', () => {
  assert.deepEqual(installOutcome('ok'), { ok: true, hint: '' })
  assert.match(installOutcome('need_permission').hint, /允許/)
  assert.match(installOutcome('unsupported').hint, /不提供/)
  for (const r of ['error', undefined, '']) assert.equal(installOutcome(r).ok, false)
  const on = { ...initialUpdate(), enabled: true }
  assert.equal(shouldAutoCheck(on, { autoUpdate: true }), true)
  assert.equal(shouldAutoCheck(on, { autoUpdate: false }), false, '設定可關閉自動檢查')
  assert.equal(shouldAutoCheck({ ...on, phase: 'downloading' }, { autoUpdate: true }), false)
  assert.equal(shouldAutoCheck(initialUpdate(), { autoUpdate: true }), false, '沒有更新功能（Play 版）就不查')
  const b = androidBridge({ AsnAndroid: { vibrate() {}, selfUpdateEnabled: () => true, installApk: p => (p.endsWith('.apk') ? 'ok' : 'error') } })
  assert.equal(b.selfUpdateEnabled(), true); assert.equal(b.installApk('/x/a.apk'), 'ok')
  assert.equal(androidBridge({ AsnAndroid: { vibrate() {} } }).selfUpdateEnabled(), false, '外殼沒有這個方法＝沒有更新功能')
  assert.equal(androidBridge({ AsnAndroid: { vibrate() {} } }).installApk('/x'), 'error')
})

test('下拉重整：拉動有阻尼與上限；到門檻才算「放開重新整理」；沒到門檻或更新中放開不更新', () => {
  assert.equal(pullHeight(-20), 0); assert.equal(pullHeight(0), 0)
  assert.equal(pullHeight(100), 50); assert.equal(pullHeight(10_000), PTR_MAX, '有上限')
  assert.ok(pullHeight(60) < 60, '有阻尼（手指拉得比畫面長得快）')
  assert.equal(pullRatio(0), 0); assert.equal(pullRatio(PTR_THRESHOLD / 2), 0.5); assert.equal(pullRatio(9999), 1)
  assert.equal(pullPhase(0), 'idle'); assert.equal(pullPhase(10), 'pull'); assert.equal(pullPhase(PTR_THRESHOLD), 'ready'); assert.equal(pullPhase(PTR_THRESHOLD, true), 'loading')
  assert.equal(PULL_TEXT.pull, '下拉重新整理'); assert.equal(PULL_TEXT.ready, '放開重新整理'); assert.equal(PULL_TEXT.loading, '更新中…')
  assert.equal(shouldRefreshOnRelease(PTR_THRESHOLD, false), true)
  assert.equal(shouldRefreshOnRelease(PTR_THRESHOLD - 1, false), false)
  assert.equal(shouldRefreshOnRelease(PTR_MAX, true), false, '更新中不重複觸發')
  assert.ok(PTR_LOADING_H >= 76 && PTR_LOADING_H <= PTR_MAX, '更新中那塊要放得下機器人與文字（高度夠）')
})

test('檢查更新失敗：不顯示原始錯誤（狀態碼、英文），一律「暫時無法檢查更新」；沒有新版是「目前已是最新版」', () => {
  for (const raw of ['更新伺服器回應異常（500）', 'error sending request for url (https://x)', 'HTTP 404', undefined, '']) assert.equal(updateCheckErrorText(raw), '暫時無法檢查更新')
  assert.equal(UPDATE_UNAVAILABLE, '暫時無法檢查更新'); assert.equal(UPDATE_LATEST, '目前已是最新版')
})

test('我的名字（帳號層）：用租戶稱呼；還是預設稱呼或沒取到就退到 email 帳號部分，再沒有就「我」', () => {
  assert.equal(accountDisplayName(' 啟良 ', 'a@b.c'), '啟良')
  assert.equal(accountDisplayName('朋友', 'qiliang@example.com'), 'qiliang', '建租戶時的預設稱呼不當名字')
  assert.equal(accountDisplayName('', 'qiliang@example.com'), 'qiliang')
  assert.equal(accountDisplayName(undefined, ''), '我'); assert.equal(accountDisplayName(null, undefined), '我')
})

test('最後一句話：只取對方寄來的；自己寄的、震動、系統提示都跳過找前一則；只有照片就顯示「傳來了一張照片」；單行不超過 80 字', () => {
  const log = [{ k: 'them', text: '早安\n今天先看哪一份？', t: 1 }, { k: 'me', text: '先看排程', t: 2 }, { k: 'sys', nudge: true, text: '甲 傳送了一個震動。', t: 3 }, { k: 'sys', text: '甲 → 未指定收件人', t: 4 }]
  assert.equal(lastWords(log), '早安 今天先看哪一份？', '自己的、震動、系統提示都不算，往前找到對方最後一句')
  assert.equal(lastWords([{ k: 'me', text: '嗨', t: 1 }]), '', '只有自己說的＝沒有')
  assert.equal(lastWords([]), ''); assert.equal(lastWords(undefined), '')
  assert.equal(lastWords([{ k: 'them', text: '  ', t: 1 }, { k: 'them', text: '前一則', t: 0 }]), '前一則', '空白的信跳過')
  assert.match(lastWords([{ k: 'them', text: '', photos: [{ kind: 'image' }], t: 1 }]), /照片/)
  assert.match(lastWords([{ k: 'them', text: '', photos: [{ kind: 'file' }], t: 1 }]), /檔案/)
  assert.equal(lastWords([{ k: 'them', text: '字'.repeat(300), t: 1 }]).length, LAST_WORDS_MAX)
})

test('補往來的佇列：本機有最後一句話的不補；每位最多一次；整個執行期有上限；依畫面順序', () => {
  const fl = ['A', 'B', 'C', 'D'].map(id => ({ id }))
  const has = new Set(['B'])
  const q = backfillQueue(fl, { lastOf: id => (has.has(id) ? '有' : ''), tried: new Set(['A']) })
  assert.deepEqual(q.slice(0, 2), ['C', 'D'], '跳過已試過的 A 與本機已有的 B，照順序')
  assert.deepEqual(backfillQueue(fl, { lastOf: () => '', tried: new Set(), max: 2 }), ['A', 'B'], '上限')
  assert.deepEqual(backfillQueue(fl, { lastOf: () => '', tried: new Set(['x', 'y']), max: 2 }), [], '已用掉的額度也算')
  assert.ok(BACKFILL_MAX >= 20 && BACKFILL_MAX <= 60)
  assert.deepEqual(backfillQueue(null, { lastOf: () => '' }), [])
})

test('廠商徽章：各廠商用電腦版的官方圖，ASN 自己的視窗用機器人 logo，不認得的用通用圖', () => {
  const svg = k => vendorBadgeHtml({ engine: k })
  assert.match(svg('claude'), /^<svg/); assert.match(svg('gemini'), /^<svg/); assert.match(svg('codex'), /^<svg/); assert.match(svg('grok'), /^<svg/)
  assert.notEqual(svg('claude'), svg('gemini'))
  assert.equal(vendorBadgeHtml({ engine: 'asn' }), ASN_BADGE); assert.match(ASN_BADGE, /img\/logo\.svg/)
  assert.match(vendorBadgeHtml({ engine: null, kind: 'claude' }), /^<svg/, '沒回報引擎就用節點種類')
  assert.match(vendorBadgeHtml({}), /^<svg/, '都沒有＝通用圖，不會是空的')
})

test('大分頁：夥伴／對話／設置三個，順序固定，名稱純中文', () => {
  assert.deepEqual(TABS, ['list', 'chats', 'me']); assert.deepEqual(TABS.map(t => TAB_LABEL[t]), ['夥伴', '對話', '設置'])
  assert.deepEqual(TABS.map(tabIndex), [0, 1, 2]); assert.equal(tabIndex('亂寫'), 0)
})

test('滑動手勢：邊緣不接手、水平要明顯大於垂直才算、斜的與上下捲動算垂直', () => {
  assert.equal(swipeStartOk(EDGE_PX - 1, 360), false, '離左邊緣太近（系統返回手勢）')
  assert.equal(swipeStartOk(360 - EDGE_PX + 1, 360), false, '離右邊緣太近')
  assert.equal(swipeStartOk(EDGE_PX, 360), true); assert.equal(swipeStartOk(180, 360), true)
  assert.equal(swipeLock(4, 3), null, '還看不出來')
  assert.equal(swipeLock(40, 8), 'h'); assert.equal(swipeLock(-60, 20), 'h')
  assert.equal(swipeLock(40, 30), 'v', '斜的算垂直（選文字、上下捲動不誤判）')
  assert.equal(swipeLock(10, 40), 'v'); assert.equal(swipeLock(0, -30), 'v')
  assert.equal(swipeLock(20, 11), null, '水平夠但垂直還不到 2 倍：再看一下')
  assert.match(SWIPE_BLOCK_SELECTOR, /input/); assert.match(SWIPE_BLOCK_SELECTOR, /textarea/); assert.match(SWIPE_BLOCK_SELECTOR, /\.toolbar/); assert.match(SWIPE_BLOCK_SELECTOR, /\.photo-viewer/)
})

test('滑動吸附：拖過一定比例或夠快才換頁；到頭不能再換；邊界有橡皮筋；指示條跟著手指', () => {
  const W = 360
  assert.equal(swipeTarget({ index: 0, dx: -W * COMMIT_FRAC - 1, dt: 600, width: W }), 1, '往左滑＝下一頁')
  assert.equal(swipeTarget({ index: 1, dx: W * COMMIT_FRAC + 1, dt: 600, width: W }), 0, '往右滑＝上一頁')
  assert.equal(swipeTarget({ index: 1, dx: -40, dt: 800, width: W }), 1, '拖得不夠、也不快＝彈回來')
  assert.equal(swipeTarget({ index: 1, dx: -50, dt: 60, width: W }), 2, '很快的短滑（甩）也換頁')
  assert.equal(swipeTarget({ index: 1, dx: -10, dt: 10, width: W }), 1, '太短的不算')
  assert.equal(swipeTarget({ index: 0, dx: 200, dt: 100, width: W }), 0, '最左邊再往右滑還是第一頁')
  assert.equal(swipeTarget({ index: 2, dx: -200, dt: 100, width: W }), 2, '最右邊再往左滑還是最後一頁')
  assert.equal(pagerShift(1, 100), 100); assert.equal(pagerShift(0, 100), 30); assert.equal(pagerShift(2, -100), -30); assert.equal(pagerShift(0, -100), -100)
  assert.equal(indicatorPos(1, 0, W), 1); assert.equal(indicatorPos(1, -W / 2, W), 1.5, '往左拖半頁，指示條走到一半')
  assert.equal(indicatorPos(0, 500, W), 0, '不會跑出左邊'); assert.equal(indicatorPos(2, -500, W), 2)
})

