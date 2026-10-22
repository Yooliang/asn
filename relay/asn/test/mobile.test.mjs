// 手機版（安卓）的純邏輯：單欄導覽、名單分組、提示規則、外殼橋、登入後的下一步。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchNav } from '../ui/lib/mobile.mjs'
import { BANNER_MS, DEFAULT_PREFS, MSG_VIBRATE_MS, NUDGE_VIBRATE_MS, UPDATE_CHECK_MS, afterBind, bannerText, buttonLabel, initialUpdate, installOutcome, progressText, shouldAutoCheck, withAvailable, withFailure, withProgress, androidBridge, chatNav, initialNav, meNav, normalizeNav, normalizePrefs, notifyPlan, rosterGroups, savePhotoOnPhone, totalUnread } from '../ui/lib/mobile.mjs'
import { groupHeading } from '../ui/lib/tabs.mjs'

const F = (id, node, nick, status = 'online', extra = {}) => ({ id, node, agent: nick, nick, status, device: `設備${node}`, unread: 0, ...extra })

test('導覽：名單 → 對話、名單 → 我；瀏覽記錄裡的壞資料一律退回名單', () => {
  assert.deepEqual(initialNav(), { tab: 'list', chat: '', sheet: '' })
  assert.deepEqual(chatNav('A/x'), { tab: 'list', chat: 'A/x', sheet: '' })
  assert.deepEqual(meNav(), { tab: 'me', chat: '', sheet: '' })
  assert.deepEqual(launchNav(), { tab: 'list', chat: '', sheet: 'launch' })
  assert.deepEqual(normalizeNav({ sheet: 'launch', tab: 'me' }), launchNav())
  assert.deepEqual(normalizeNav({ sheet: 'other' }), initialNav())
  assert.deepEqual(normalizeNav({ tab: 'me', chat: '' }), meNav())
  assert.deepEqual(normalizeNav({ chat: 'A/x', tab: 'me' }), chatNav('A/x'), '有對話就是對話層')
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
