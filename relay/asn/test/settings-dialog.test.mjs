// 設定頁分類列表＋共用對話框：分類定義、摘要文字（純邏輯）、對話框關閉規則，以及畫面接線的守門
// （每個舊設定項目都還在、浮層用 position:fixed、不放進 overflow:hidden 的容器）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SETTING_CATS, SETTING_KEYS, catByKey, catSummary } from '../ui/lib/settings-cats.mjs'
import { closesDialog } from '../ui/lib/dialog.mjs'

const read = f => fs.readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('分類：十類、順序與鍵固定、標題與圖示都有、鍵不重複', () => {
  assert.deepEqual(SETTING_KEYS, ['me', 'accounts', 'look', 'tabs', 'sound', 'voice', 'window', 'launch', 'update', 'about'])
  assert.deepEqual(SETTING_CATS.map(c => c.title), ['個人', 'Claude 帳號', '外觀', '分頁與分組', '音效', '語音', '視窗與系統匣', '啟動設定', '更新', '關於'])
  assert.equal(new Set(SETTING_KEYS).size, SETTING_CATS.length)
  for (const c of SETTING_CATS) assert.ok(/^M[0-9A-Za-z .,-]+$/.test(c.icon), `${c.key} 圖示`)
  assert.equal(catByKey('voice').title, '語音')
  assert.equal(catByKey('nope'), null)
})

test('摘要：每一類都有一行文字，缺欄位不丟錯', () => {
  for (const c of SETTING_CATS) {
    assert.doesNotThrow(() => catSummary(c.key, {}), c.key)
    assert.doesNotThrow(() => catSummary(c.key), c.key)
    assert.ok(catSummary(c.key, {}).trim(), `${c.key} 摘要不空`)
    assert.ok(!catSummary(c.key, {}).includes('\n'), `${c.key} 只有一行`)
  }
  assert.equal(catSummary('nope', {}), '')
})

test('摘要：照目前的值顯示', () => {
  assert.equal(catSummary('me', { hasUpload: true }), '已上傳大頭貼')
  assert.equal(catSummary('me', { hasUpload: false }), '自動產生的大頭貼')
  assert.equal(catSummary('accounts', { accountCount: 0 }), '還沒有存過帳號')
  assert.equal(catSummary('accounts', { accountCount: 2, accountCurrent: '工作' }), '2 個帳號，使用中：工作')
  assert.equal(catSummary('accounts', { accountCount: 2 }), '2 個帳號')
  const look = catSummary('look', { frame: 'native', mode: 'merged', dpMode: 'side', toolbar: 'top', bubble: 'bubble' })
  assert.ok(look.includes('Windows 原生'), look)
  assert.equal(catSummary('tabs', { tabDim: 'device', groupDim: 'status' }), '分頁依設備、分組依狀態')
  assert.equal(catSummary('sound', { soundOn: true }), '音效：開')
  assert.equal(catSummary('sound', { soundOn: false }), '音效：關')
  assert.equal(catSummary('voice', { voiceEnabled: false }), '念出訊息尚未啟用')
  assert.equal(catSummary('voice', { voiceEnabled: true, ttsAuto: true, sttLang: 'en' }), '自動念：開、輸入語言：英文')
  assert.equal(catSummary('window', { closeTo: 'tray', trayOk: true, autostartSupported: true, autostartOn: true }), '關閉時縮到系統匣、開機啟動：開')
  assert.equal(catSummary('window', { closeTo: 'tray', trayOk: false, autostartSupported: false }), '關閉時結束程式', '建不起系統匣＝一律結束')
  assert.equal(catSummary('launch', { maxPerHour: 6, cwdCount: 3 }), '每小時上限 6 個、白名單 3 個資料夾')
  assert.equal(catSummary('update', { autoCheck: true }), '自動檢查：開')
  assert.equal(catSummary('about', { version: '0.1.9' }), '版本 0.1.9')
})

test('對話框：只有 Esc 會關；別的元件已處理過的 Esc 不重複處理', () => {
  assert.equal(closesDialog({ key: 'Escape' }), true)
  assert.equal(closesDialog({ key: 'Enter' }), false)
  assert.equal(closesDialog({ key: 'Escape', defaultPrevented: true }), false)
  assert.equal(closesDialog(null), false)
})

test('守門：舊設定頁的每個項目都還在（分到各分類的對話框裡），存檔欄位的綁定不變', () => {
  const html = read('list.html')
  const dlg = html.slice(html.indexOf('<asn-dialog'), html.indexOf('</asn-dialog>'))
  const labels = ['音效', '念出訊息的聲音', '收到新訊息自動念', '語音輸入的語言', '語音辨識模型', '下載語音辨識', 'Claude 帳號', '存成帳號', '視窗外框', '關閉視窗時',
    '登入時自動啟動 ASN', '自動檢查更新', '立即檢查', '視窗模式', '頭像模式', '工具列位置', '文字底色', '分頁依', '分組依', '每小時開新夥伴上限', '工作資料夾白名單', '選擇圖片', '移除，改回自動產生']
  for (const l of labels) assert.ok(dlg.includes(l), `對話框裡缺「${l}」`)
  for (const k of ['accounts.switchTo(a.name)', 'accounts.remove(a.name)', 'accounts.save()', 'setFrame($event.target.value)', 'setCloseTo($event.target.value)', 'setAutostart($event.target.checked)',
    'v-model="autoCheck"', 'checkUpdate(true)', 'setMode($event.target.value)', 'v-model="ui.dpMode"', 'v-model="ui.toolbar"', 'v-model="ui.bubble"', 'setTabDim($event.target.value)',
    'v-model="dims.groupDim"', 'saveVoice({ tts_voice', 'saveVoice({ tts_auto', 'saveVoice({ stt_lang', 'saveVoice({ stt_model', 'installFromSettings', 'removeAvatar', 'saveLaunchPrefs', 'setLaunchCwdText', 'soundFromChoice']) {
    assert.ok(dlg.includes(k), `對話框裡缺綁定 ${k}`)
  }
  assert.ok(dlg.includes('版本 {{ version }}'))
  for (const c of SETTING_CATS) assert.ok(dlg.includes(`dlg.key === '${c.key}'`), `${c.key} 沒有對應的對話框內容`)
  // 設定頁本身只剩分類列表：沒有任何表單控制項
  const list = /<div class="list cat-list"[\s\S]*?<\/ul>/.exec(html)[0]
  assert.ok(!/<select|<input|<textarea/.test(list))
  assert.ok(list.includes('openSettingDlg(c.key)') && list.includes('catSub(c.key)'))
})

test('守門：對話框用 position:fixed 蓋在最上層，放在 #app 底下而不是 overflow:hidden 的容器裡；深淺色走色彩變數', () => {
  const html = read('list.html'), css = read('style.css'), dlgJs = read('lib/dialog.mjs')
  assert.match(css, /\.dlg-back\{position:fixed;inset:0;/)
  assert.match(css, /\.dlg-body\{[^}]*overflow-y:auto/, '內容可捲動')
  assert.match(css, /\.dlg\{[^}]*max-height:100%/, '窄視窗不超出')
  assert.match(css, /\.dlg\{[^}]*background:var\(--panel\)/)
  const at = html.indexOf('<asn-dialog')
  const before = html.slice(0, at)
  const opens = (before.match(/<div[\s>]/g) || []).length, closes = (before.match(/<\/div>/g) || []).length
  assert.equal(opens - closes, 1, '只在 #app 底下（沒有包在 shell、list-pane、chat-area 等容器裡）')
  assert.ok(dlgJs.includes("@mousedown.self=\"$emit('close')\"") && dlgJs.includes('dlg-x') && dlgJs.includes("'keydown'"), '點遮罩、✕、Esc 都能關')
  assert.ok(!/v-html/.test(dlgJs))
  assert.match(read('list.js'), /app\.component\('asn-dialog', AsnDialog\)/)
})
