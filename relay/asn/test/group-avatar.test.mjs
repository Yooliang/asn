// 群組訊息顯示大頭照（#223）：每位發言的成員（人與 AI）都有大頭貼種子，與個人名單同一套預設圖；畫面不外露成員鍵。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { autoAvatarDataUrl, avatarSrc } from '../ui/lib/avatar.mjs'
import { speakerAvatarSeed } from '../ui/lib/groups.mjs'
import { roomLog } from '../ui/lib/mobile-rooms.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'package.json'))
const { compile } = require('@vue/compiler-dom')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n')
const chatpane = read('ui', 'lib', 'chatpane.mjs')
const tpl = /template: `([\s\S]*?)`,?\n?\}/.exec(chatpane)[1]

test('大頭貼種子：自己名下的 AI 與個人聊天同一張（節點/視窗名）；別人的與真人用對外代號，缺資料回空字串', () => {
  assert.equal(speakerAvatarSeed('H~財務'), 'H/財務', '與個人名單的 id（節點/視窗名）一致，同一位夥伴兩邊同一張圖')
  assert.equal(speakerAvatarSeed('x:0b9c8f3a-1111'), 'x:0b9c8f3a-1111')
  assert.equal(speakerAvatarSeed('~u:3cda66252c34'), '~u:3cda66252c34')
  assert.equal(speakerAvatarSeed('~owner'), '~owner')
  for (const bad of ['', null, undefined, 5]) assert.equal(speakerAvatarSeed(bad), '')
  // 個人聊天用 avatarSrc(好友)；群組用種子直接產生，兩者對同一位 AI 要得到同一張
  assert.equal(autoAvatarDataUrl(speakerAvatarSeed('H~財務')), avatarSrc({ id: 'H/財務', node: 'H', onRoster: true }, {}))
})

test('訊息轉對話記錄：真人與 AI 每則都帶大頭貼種子，我自己與系統訊息不帶', () => {
  const log = roomLog([
    { seq: 1, from: '~u:me', relation: 'mine', from_kind: 'human', from_label: '牧陽', body: '嗨', at: '2026-10-23T10:00:00Z' },
    { seq: 2, from: 'T~財務', relation: 'mine_ai', from_kind: 'ai', from_label: '財務（牧陽）', body: '收到', at: '2026-10-23T10:01:00Z' },
    { seq: 3, from: 'x:r1aaaaaa', relation: 'other', from_kind: 'human', from_label: '小良', body: '請查', at: '2026-10-23T10:02:00Z' },
    { seq: 4, from: 'x:r2bbbbbb', relation: 'other', from_kind: 'ai', from_label: '報表（小良）', body: '好', at: '2026-10-23T10:03:00Z' },
    { seq: 5, from: '~u:me', relation: 'system', from_kind: 'system', body: '小良 加入了群組。', at: '2026-10-23T10:04:00Z' },
  ], ['~u:me', 'T~財務'], [])
  assert.deepEqual(log.map(e => e.av ?? ''), ['', 'T/財務', 'x:r1aaaaaa', 'x:r2bbbbbb', ''])
  // 舊後台沒給 from 的訊息：沒有種子，畫面退回名字首字徽章
  assert.equal(roomLog([{ seq: 1, body: 'x' }], [], [])[0].av ?? '', '')
})

test('群組訊息樣板：每則對方訊息放發言者自己的大頭貼（不論頭像模式），沒有種子才退回首字徽章；樣板能編譯', () => {
  const errs = []
  compile(tpl, { onError: e => errs.push(e.message) })
  assert.deepEqual(errs, [])
  // 10-25：頭像下方的「AI」小標籤改成右下角的廠商小圖（spk-vendor）、離線時整欄帶 is-off；頭像本身（speakerAv）不變
  assert.match(tpl, /<div class="m-av m-av-spk"[^>]* v-if="m\.av"><div class="dp xs"[^>]*><span><img :src="speakerAv\(m\)" alt=""><\/span><\/div>(<span class="spk-vendor"[^>]*><\/span>)?<\/div>/)
  assert.doesNotMatch(tpl, /av-tag/)
  assert.match(tpl, /<span class="spk-av" :class="'is-' \+ m\.kind" v-if="m\.badge && !m\.av"/, '有大頭貼就不再畫首字徽章')
  assert.match(chatpane, /import \{[^}]*autoAvatarDataUrl[^}]*\} from '\.\/avatar\.mjs'/)
  assert.match(chatpane, /const speakerAv = m => autoAvatarDataUrl\(m\.av\)/)
  // 個人聊天那一顆照舊：只在頭像模式 inline 且不是群組發言者時畫
  assert.match(tpl, /v-if="lay\(m\.k\)\.avatar && !m\.badge && !m\.av"/)
})

test('樣式：群組發言者的大頭貼不論頭像模式都排在訊息左側、不被擠扁', () => {
  const css = read('ui', 'group.css')
  assert.match(css, /\.m-av-spk\{[^}]*flex:none/)
})
