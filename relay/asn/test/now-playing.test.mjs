// 「顯示正在聽的歌」守門：預設關、開了才讀才送、只送歌名與歌手、設定頁有開關。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { NOW_PLAYING_PREFIX, normalizeNowPlaying, nowPlayingLine } from '../ui/lib/now-playing.mjs'
import { SETTING_OPS, SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { catSummary } from '../ui/lib/settings-cats.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

test('存檔值：沒欄位的舊存檔與壞值都是關，只有明確 true 才開', () => {
  assert.equal(normalizeNowPlaying(undefined), false)
  for (const v of [null, '', 'true', 1, 'on', {}, []]) assert.equal(normalizeNowPlaying(v), false, String(v))
  assert.equal(normalizeNowPlaying(true), true)
})

test('自己名單頭那一行：沒在聽不顯示，控制字元與方向字元濾掉', () => {
  assert.equal(nowPlayingLine(''), '')
  assert.equal(nowPlayingLine(undefined), '')
  assert.equal(nowPlayingLine('夜曲 - 周杰倫'), `${NOW_PLAYING_PREFIX}夜曲 - 周杰倫`)
  assert.equal(nowPlayingLine('a\u0000b‮c\n'), '♪ 正在聽：abc')
  assert.equal(NOW_PLAYING_PREFIX, '♪ 正在聽：')
})

test('設定頁：個人分類有「顯示正在聽的歌」開關，預設未勾；指令在清單裡', () => {
  assert.ok(SETTING_OPS.includes('now-playing'))
  const t = SettingsPanel.template
  assert.match(t, /顯示正在聽的歌/)
  assert.match(t, /act\('now-playing', \$event\.target\.checked\)/)
  assert.match(t, /:checked="st\.nowPlaying\?\.on === true"/, '沒有狀態時視為未勾')
  assert.equal(catSummary('me', { hasUpload: false }), '自動產生的大頭貼')
  assert.equal(catSummary('me', { hasUpload: false, nowPlayingOn: true }), '自動產生的大頭貼、顯示正在聽的歌')
})

test('介面接線：存檔值進 me 存檔、開關交給 set_now_playing、歌由 asn:now-playing 事件推來', () => {
  const js = read('ui/list.js')
  assert.match(js, /showNowPlaying = ref\(normalizeNowPlaying\(savedMe\.showNowPlaying\)\)/)
  assert.match(js, /invoke\('set_now_playing', \{ on \}\)/)
  assert.match(js, /listen\('asn:now-playing'/)
  assert.match(js, /case 'now-playing': showNowPlaying\.value = value === true/)
  assert.match(js, /showNowPlaying: showNowPlaying\.value/)
  assert.match(read('ui/list.html'), /class="me-np" v-if="nowPlayingText"/)
})

test('Rust 接線：開關預設關、關著不讀、只送歌名與歌手、已登記指令與事件', () => {
  const rs = read('src-tauri/src/nowplaying.rs')
  const lib = read('src-tauri/src/lib.rs')
  const relay = read('src-tauri/src/relay.rs')
  assert.match(lib, /fn set_now_playing\(/)
  assert.match(lib, /generate_handler!\[[^\]]*set_now_playing/)
  assert.match(lib, /"asn:now-playing"/)
  // 關著不碰來源
  assert.match(rs, /pub fn poll_once\(enabled: bool, src: &dyn MediaSource\)[\s\S]*?if !enabled \{\s*return None;\s*\}/)
  // 讀出來的東西只有 Title 與 Artist 兩項
  const sys = rs.slice(rs.indexOf('pub mod sys'))
  assert.match(sys, /p\.Title\(\)/)
  assert.match(sys, /p\.Artist\(\)/)
  for (const banned of ['Thumbnail', 'AlbumTitle', 'AlbumArtist', 'SourceAppUserModelId', 'GetTimelineProperties', 'Position']) {
    assert.ok(!sys.includes(banned), `不可讀 ${banned}`)
  }
  // 回報時經 compose_psm 才進個人訊息；沒有別的欄位
  assert.match(relay, /compose_psm\(&psm, &self\.now_playing\.current\(\)\)/)
  // 非 Windows 安靜略過
  assert.match(rs, /#\[cfg\(not\(windows\)\)\]/)
})
