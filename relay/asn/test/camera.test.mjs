// 拍照（#1490）：手機輸入列的相機鈕
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

test('相機鈕只在手機的對話輸入列：chatpane 預設不放，m.html 只有一般對話打開（通知對話不放）', () => {
  const pane = read('ui/lib/chatpane.mjs')
  assert.match(pane, /camera: \{ type: Boolean, default: false \}/)
  assert.match(pane, /<button class="tool icon cam" type="button" v-if="camera" @click="openCamera" :disabled="photoBusy" aria-label="拍照"/)
  assert.match(pane, /<line-icon name="camera"><\/line-icon>/, '現代外觀用線條圖示')
  const html = read('ui/m.html')
  assert.equal((html.match(/:camera="true"/g) ?? []).length, 1)
  const notice = html.slice(html.indexOf('aria-label="通知"'), html.indexOf('</section>', html.indexOf('aria-label="通知"')))
  assert.doesNotMatch(notice, /camera/, '通知對話唯讀，不放相機')
  for (const f of ['ui/list.html', 'ui/chat.html']) assert.doesNotMatch(read(f), /:camera=/, `${f}：電腦不放`)
})

test('拍照走 <input capture>（系統相機 App 拍好交回），單張、只收圖；取消或沒給權限會說明、輸入列不卡', () => {
  const pane = read('ui/lib/chatpane.mjs')
  assert.match(pane, /<input ref="camEl" v-if="camera" type="file" accept="image\/\*" capture="environment" hidden @change="pickCamera" @cancel="cameraMissed"/)
  const block = pane.slice(pane.indexOf('const camEl = ref(null)'), pane.indexOf('// ---- 截圖'))
  assert.match(block, /function pickCamera\(ev\) \{ camWait\.value = false; clearTimeout\(camTimer\); if \(photoMsg\.value === CAMERA_MISS\) photoMsg\.value = ''; pickPhoto\(ev\) \}/, '拍好走跟選圖一樣的送出')
  assert.match(block, /CAMERA_MISS = '沒有拍到照片：可能取消了，或沒有允許 ASN 使用相機。/)
  assert.match(block, /window\.addEventListener\('focus', cameraBack\)/)
  assert.match(block, /window\.removeEventListener\('focus', cameraBack\); document\.removeEventListener\('visibilitychange', cameraBack\)/, '關掉對話時拆掉監聽')
  assert.doesNotMatch(block, /photoBusy\.value = true/, '開相機本身不佔用忙碌狀態，取消了輸入列也不會卡住')
})

test('不改 Android 殼、不新增權限：相機權限原本就由 QR code 掃描的函式庫帶進來', () => {
  const man = read('src-tauri/gen/android/app/src/main/AndroidManifest.xml')
  assert.doesNotMatch(man, /android\.permission\.CAMERA/, '清單裡不另外宣告相機權限')
  assert.match(man, /android\.hardware\.camera" android:required="false"/, '沒有相機的手機照樣能裝')
})
