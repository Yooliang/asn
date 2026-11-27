// 平台能力表（#1763 F1）：三張表的鍵一致、能力名稱快照、入口拿到的表、needs 只用表裡有的能力、
// 手機與電腦的設定類別由能力算出來（快照，等於 F1 之前手寫的清單）。純邏輯，不開視窗。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { capsDesktop } from '../ui/shells/caps-desktop.mjs'
import { capsAndroid } from '../ui/shells/caps-android.mjs'
import { capsWeb } from '../ui/shells/caps-web.mjs'
import { CAT_NEEDS, ITEM_NEEDS, catsFor, settingNeeds } from '../ui/lib/setting-needs.mjs'
import { SETTING_CATS } from '../ui/lib/settings-cats.mjs'
import { MOBILE_SETTING_KEYS } from '../ui/lib/mobile-settings.mjs'

// 11-26 依調查員審查定案，之後不改（#1853 會引用）
const NAMES = ['tray', 'desktopWindow', 'autostart', 'guard', 'bridge', 'localSpeech', 'hostAgents', 'claudeLocalLogs', 'push', 'shellSelfUpdate', 'vibrate', 'desktopToast', 'quotaReader', 'taskManager']
const catKeys = SETTING_CATS.map(c => c.key)
const src = f => readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8')

test('三張表的鍵完全一樣，值都是 true／false，而且表已凍結', () => {
  for (const [n, t] of [['電腦', capsDesktop], ['手機', capsAndroid], ['網頁', capsWeb]]) {
    assert.deepEqual(Object.keys(t), Object.keys(capsDesktop), `${n}那張的鍵跟電腦不一樣`)
    assert.ok(Object.isFrozen(t), `${n}那張沒有凍結`)
    for (const [k, v] of Object.entries(t)) assert.equal(typeof v, 'boolean', `${n}.${k} 不是 true／false`)
  }
})

test('能力名稱快照：能力名稱定了不能改，#1853 會引用', () => {
  assert.deepEqual(Object.keys(capsDesktop), NAMES, '能力名稱定了不能改，#1853 會引用')
})

test('電腦與手機的能力互補（這幾個本來就一邊有一邊沒有），網頁先全部沒有', () => {
  for (const k of ['tray', 'desktopWindow', 'autostart', 'guard', 'bridge', 'localSpeech', 'hostAgents', 'claudeLocalLogs', 'desktopToast', 'quotaReader', 'taskManager']) {
    assert.equal(capsDesktop[k], true, `電腦 ${k}`); assert.equal(capsAndroid[k], false, `手機 ${k}`)
  }
  for (const k of ['push', 'shellSelfUpdate', 'vibrate']) {
    assert.equal(capsDesktop[k], false, `電腦 ${k}`); assert.equal(capsAndroid[k], true, `手機 ${k}`)
  }
  assert.ok(Object.values(capsWeb).every(v => v === false))
})

test('入口：panel.js 與 list.js 拿到的是同一張（電腦），m.js 拿到手機那張', () => {
  assert.match(src('panel.js'), /import \{ capsDesktop \} from '\.\/shells\/caps-desktop\.mjs'/)
  assert.match(src('panel.js'), /export const caps = capsDesktop\b/)
  assert.match(src('list.js'), /import \{ capsDesktop \} from '\.\/shells\/caps-desktop\.mjs'/)
  assert.match(src('list.js'), /export const caps = capsDesktop\b/)
  assert.match(src('m.js'), /import \{ capsAndroid \} from '\.\/shells\/caps-android\.mjs'/)
  assert.match(src('m.js'), /export const caps = capsAndroid\b/)
})

test('needs 裡出現的每個能力名稱都在表裡；類別層每一類都有登記', () => {
  for (const [token, needs] of [...Object.entries(CAT_NEEDS), ...Object.entries(ITEM_NEEDS)]) {
    for (const n of needs) assert.ok(n in capsDesktop, `${token} 需要的「${n}」不在能力表裡`)
  }
  assert.deepEqual(Object.keys(CAT_NEEDS), catKeys.map(k => `cat.${k}`), '類別層要跟 SETTING_CATS 同一組、同順序')
  assert.deepEqual(settingNeeds('cat.window'), ['tray', 'desktopWindow'])
  for (const t of ['mode', 'dpMode', 'toolbar', 'bubble', 'tabDim', 'groupDim']) assert.deepEqual(settingNeeds(t), [], `${t} 是設計選擇，不放進能力表`)
  assert.deepEqual(settingNeeds('不存在的指令'), [])
})

test('手機的設定類別由 caps-android 算出來，等於 F1 之前的 8 類（順序一樣）', () => {
  assert.deepEqual(MOBILE_SETTING_KEYS, ['me', 'devices', 'accounts', 'cloud', 'look', 'notify', 'update', 'about'])
  assert.deepEqual(catsFor(capsAndroid, catKeys), MOBILE_SETTING_KEYS)
})

test('電腦的設定類別由 caps-desktop 算出來，等於電腦的 12 類（快照）', () => {
  assert.deepEqual(catsFor(capsDesktop, catKeys), ['me', 'devices', 'accounts', 'cloud', 'look', 'notify', 'voice', 'window', 'launch', 'usage', 'update', 'about'])
  assert.deepEqual(catsFor(capsDesktop, catKeys), catKeys)
  assert.deepEqual(catsFor(capsWeb, catKeys).filter(k => settingNeeds(`cat.${k}`).length), [], '網頁沒有任何能力，需要能力的類別都不該出現')
})
