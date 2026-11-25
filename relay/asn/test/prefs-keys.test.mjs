// #1763 T4：鎖住「存檔的鍵名」。介面三層重構（見 3.4）不准動 localStorage 鍵、prefs 欄位：回退才不需要資料還原、舊版用戶端不會壞。
// 這裡把清單抄成固定值，改了（多、少、改名）就紅；要改請同時改這份清單與對應的程式，審查者才看得到「存檔格式變了」。
//  1. localStorage 鍵（lib/local-prefs.mjs 的 LOCAL_KEYS 是唯一來源；鎖鍵改由 settings-list.test.mjs 的 file.local.* 登記負責，這裡不再抄第二份）
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
import { ME_DEVICE_FIELDS, ME_FIELDS_DESKTOP, ME_FIELDS_MOBILE } from '../ui/lib/storage-keys.mjs'
import { topFields as topFieldsOf } from './settings-list-check.mjs'

const UI = fileURLToPath(new URL('../ui', import.meta.url))
const read = f => fs.readFileSync(path.join(UI, f), 'utf8')

const MOBILE_PREFS = ['vibrateMsg', 'vibrateNudge', 'autoUpdate', 'push', 'skin', 'chatPins', 'voice']
const NOTIFY = ['toast', 'msg', 'nudge', 'file']
// 存檔欄位名單搬到 ui/lib/storage-keys.mjs（設定值清單守門也用同一份）；這裡負責把它們對到前端原始碼
const DEVICE_FIELDS = [...ME_DEVICE_FIELDS]
const DESK_ME_FIELDS = [...ME_FIELDS_DESKTOP]
const PHONE_ME_FIELDS = [...ME_FIELDS_MOBILE]

// 取頂層欄位的解析器搬到 settings-list-check.mjs（設定值清單守門也要用）；這裡綁上設備欄位
const topFields = (src, startRe) => topFieldsOf(src, startRe, DEVICE_FIELDS)

// localStorage 鍵不在這裡抄第二份了（#1853 第 2 張）：唯一來源是 lib/local-prefs.mjs 的 LOCAL_KEYS，
// 新增、改名、刪除會被 settings-list.test.mjs 擋（沒登記到 docs/設定值清單.md 的 file.local.* 就紅）
test('localStorage 鍵：沒有重複、都是字串', () => {
  assert.equal(new Set(LOCAL_KEYS).size, LOCAL_KEYS.length)
  assert.ok(LOCAL_KEYS.length >= 4 && LOCAL_KEYS.every(k => typeof k === 'string' && k))
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
