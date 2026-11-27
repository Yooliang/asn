// #2425 PR-2：對話視窗提示第一批搬家（已停止黃條改用 AsnNote、拿掉「可能無法馬上回應」）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ui = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')
const read = f => fs.readFileSync(path.join(ui, f), 'utf8').replace(/\r\n/g, '\n')
const pane = read('lib/chatpane.mjs')
const bar = read('lib/actionbar.mjs')

test('忙碌／暫離的純資訊標籤「可能無法馬上回應」拿掉（狀態本來就在名字旁的頭像上）', () => {
  assert.doesNotMatch(pane, /可能無法馬上回應/)
  assert.match(pane, /<asn-avatar class="to-av"[^>]*:status="friend\.status"/, '名字旁的頭像仍帶著對方狀態')
})

test('已停止的黃條：AsnNote 的 warn 橫幅，附「重開」鈕並接到重開動作', () => {
  assert.match(pane, /<asn-note v-if="warn === 'stopped' && canReopen" kind="warn" banner action-label="重開" @action="reopenPartner">/)
  assert.doesNotMatch(pane, /<div class="warn" v-if="warn === 'stopped'">/, '舊的黃條拿掉')
  assert.match(pane, /<action-bar ref="abEl"/, '重開走上方功能列（管理選單同一條路）')
  assert.match(pane, /const reopenPartner = \(\) => \{ abEl\.value\?\.restartPartner\?\.\(\) \}/)
})

test('已停止的黃條：重開不能按時退成不帶鈕的 info 說明，原本的說明字照舊看得到', () => {
  assert.match(pane, /<asn-note v-else-if="warn === 'stopped'" banner>[^<]*已停止，寄來的信不會處理（會收到一則說明）。要恢復請在夥伴管理按「重開」。<\/asn-note>/)
})

test('功能列的重開：只有管理選單那項「重開」能按才算，並且呼叫的就是 p:restart', () => {
  assert.match(bar, /const canRestart = computed\(\(\) => Boolean\(!lite\.value && !isRoom\.value && props\.api && opsAll\.value\.find\(i => i\.key === 'p:restart'\)\?\.ok\)\)/)
  assert.match(bar, /function restartPartner\(\) \{ if \(canRestart\.value\) void pickOps\('p:restart'\) \}/)
  assert.match(bar, /return \{ canRestart, restartPartner,/)
})
