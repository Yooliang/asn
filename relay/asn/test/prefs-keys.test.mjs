// #1763 T4：鎖住「存檔的鍵名」。介面三層重構（見 3.4）不准動 localStorage 鍵、prefs 欄位：回退才不需要資料還原、舊版用戶端不會壞。
// 這裡把清單抄成固定值，改了（多、少、改名）就紅；要改請同時改這份清單與對應的程式，審查者才看得到「存檔格式變了」。
//  1. localStorage 鍵（lib/local-prefs.mjs 的 LOCAL_KEYS；local-storage-guard.test.mjs 也守一份，這裡再鎖順序與內容）
//  2. 手機本機偏好 mobilePrefs 的欄位（DEFAULT_PREFS、normalizePrefs 輸出）
//  3. 提醒開關 notify 的欄位（NOTIFY_KEYS）
//  4. 設備排序欄位（deviceFieldsToSave）
//  5. 設定檔（me）頂層欄位：電腦 list.js 的 saveMe、手機 m.js 的存檔那一行，各自送出哪些欄位
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCAL_KEYS } from '../ui/lib/local-prefs.mjs'
import { DEFAULT_PREFS, normalizePrefs } from '../ui/lib/mobile.mjs'
import { NOTIFY_KEYS } from '../ui/lib/prefs.mjs'
import { deviceFieldsToSave } from '../ui/lib/device-order.mjs'

const UI = fileURLToPath(new URL('../ui', import.meta.url))
const read = f => fs.readFileSync(path.join(UI, f), 'utf8')

const LOCAL = ['asnSkin', 'asnCloudNodes', 'asnNewComputerGuideHidden', 'asnUpdateTestUrl']
const MOBILE_PREFS = ['vibrateMsg', 'vibrateNudge', 'autoUpdate', 'push', 'skin', 'chatPins']
const NOTIFY = ['toast', 'msg', 'nudge', 'file']
const DEVICE_FIELDS = ['deviceOrder', 'deviceShown', 'deviceRemoved', 'deviceRev', 'deviceSynced']
const DESK_ME_FIELDS = ['autoAddClaude', 'autoUpdate', 'bubble', 'chatPins', 'closeTo', 'dpCollapsed', 'dpMode', 'frame', 'groupDim', 'guideSize', 'me', 'mergedSize', 'notify', 'pinnedChat', 'session', 'settingSize', 'showNowPlaying', 'skin', 'splitSize', 'tabDim', 'toolbar', 'winMode', ...DEVICE_FIELDS].sort()
const PHONE_ME_FIELDS = ['lastChat', 'me', 'mobilePrefs', 'navChat', 'navTab', 'ownerName', ...DEVICE_FIELDS].sort()

// 從原始碼取出 `const f = { … }; void patchWithFallback` 的頂層欄位名（`...deviceFieldsToSave(devPrefs)` 展開成裝置欄位）
export const topFields = (src, startRe) => {
  const m = startRe.exec(src)
  assert.ok(m, `找不到存檔欄位那一行：${startRe}`)
  let i = src.indexOf('{', m.index + m[0].length - 1)
  let depth = 0, cur = '', part = []
  for (; i < src.length; i++) {
    const ch = src[i]
    if ('{[('.includes(ch)) { if (depth++ === 0) continue }
    if ('}])'.includes(ch)) { if (--depth === 0) { part.push(cur); break } }
    if (ch === ',' && depth === 1) { part.push(cur); cur = ''; continue }
    cur += ch
  }
  return part.map(s => s.trim()).filter(Boolean).flatMap(s => {
    if (s.startsWith('...deviceFieldsToSave')) return DEVICE_FIELDS
    const name = /^([A-Za-z_$][\w$]*)\s*(:|$)/.exec(s)
    assert.ok(name, `看不懂的存檔欄位：${s.slice(0, 40)}`)
    return [name[1]]
  }).sort()
}

test('localStorage 鍵：固定四個，順序也不變', () => {
  assert.deepEqual([...LOCAL_KEYS], LOCAL)
})

test('手機本機偏好 mobilePrefs 欄位固定（預設值與正規化輸出都一樣）', () => {
  assert.deepEqual(Object.keys(DEFAULT_PREFS), MOBILE_PREFS)
  assert.deepEqual(Object.keys(normalizePrefs({})), MOBILE_PREFS)
})

test('提醒開關 notify 欄位固定', () => {
  assert.deepEqual([...NOTIFY_KEYS], NOTIFY)
})

test('設備排序欄位固定', () => {
  assert.deepEqual(Object.keys(deviceFieldsToSave({})), DEVICE_FIELDS)
})

test('電腦存檔（list.js 的 saveMe）送出的頂層欄位固定', () => {
  assert.deepEqual(topFields(read('list.js'), /const saveMe = trailingThrottle\(\(\) => \{[^]*?const f = \{/), DESK_ME_FIELDS)
})

test('手機存檔（m.js 的 watch）送出的頂層欄位固定', () => {
  assert.deepEqual(topFields(read('m.js'), /watch\(\[me, prefs, devPrefs[^]*?const f = \{/), PHONE_ME_FIELDS)
})

test('自我檢查：topFields 讀得懂巢狀的逗號，也會抓到多一個或少一個欄位', () => {
  const src = 'const f = { ...deviceFieldsToSave(d), a: { x: 1, y: [1, 2] }, b, c: g(1, 2) }; void x'
  assert.deepEqual(topFields(src, /const f = \{/), [...DEVICE_FIELDS, 'a', 'b', 'c'].sort())
  assert.notDeepEqual(topFields(src.replace('b, ', ''), /const f = \{/), topFields(src, /const f = \{/))
})
