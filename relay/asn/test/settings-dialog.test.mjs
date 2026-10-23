// 設定的分類列表＋設定聊天窗：分類定義、摘要文字（純邏輯）、設定表單元件（真的用 Vue 轉成 HTML 看內容）、
// 樞紐接得住元件送的每個指令，以及畫面接線的守門（設定不再用彈出對話框，改成跟好友聊天窗同一套）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { SETTING_CATS, SETTING_KEYS, catByKey, catSummary } from '../ui/lib/settings-cats.mjs'
import { SETTING_OPS, SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { closesDialog } from '../ui/lib/dialog.mjs'

const read = f => fs.readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('分類：十一類、順序與鍵固定、標題與圖示都有、鍵不重複', () => {
  assert.deepEqual(SETTING_KEYS, ['me', 'accounts', 'look', 'tabs', 'notify', 'voice', 'window', 'launch', 'usage', 'update', 'about'])
  assert.deepEqual(SETTING_CATS.map(c => c.title), ['個人', '帳號', '外觀', '分頁與分組', '通知', '語音', '視窗與系統匣', '啟動設定', '用量', '更新', '關於'])
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
  assert.equal(catSummary('accounts', { accountCount: 0 }), '還沒有加入過帳號')
  assert.equal(catSummary('accounts', { accountCount: 0, accountCurrent: 'a@x.test' }), '使用中：a@x.test（還沒加入帳號庫）')
  assert.equal(catSummary('accounts', { accountCount: 2, accountCurrent: 'a@x.test' }), '2 個 Claude 帳號，使用中：a@x.test')
  assert.equal(catSummary('accounts', { accountCount: 2 }), '2 個 Claude 帳號')
  const look = catSummary('look', { frame: 'native', mode: 'merged', dpMode: 'side', toolbar: 'top', bubble: 'bubble' })
  assert.ok(look.includes('Windows 原生'), look)
  assert.equal(catSummary('tabs', { tabDim: 'device', groupDim: 'status' }), '分頁依設備、分組依狀態')
  assert.equal(catSummary('notify', { notify: { toast: true, msg: true, nudge: false, file: false } }), '右下角通知、通知聲音')
  assert.equal(catSummary('notify', { notify: { toast: false, msg: false, nudge: false, file: false } }), '全部關閉')
  assert.equal(catSummary('voice', { voiceEnabled: false }), '念出訊息尚未啟用')
  assert.equal(catSummary('voice', { voiceEnabled: true, ttsAuto: true, sttLang: 'en' }), '自動念：開、輸入語言：英文')
  assert.equal(catSummary('window', { closeTo: 'tray', trayOk: true, autostartSupported: true, autostartOn: true }), '關閉時縮到系統匣、開機啟動：開')
  assert.equal(catSummary('window', { closeTo: 'tray', trayOk: false, autostartSupported: false }), '關閉時結束程式', '建不起系統匣＝一律結束')
  assert.equal(catSummary('launch', { maxPerHour: 6, cwdCount: 3 }), '每小時上限 6 個、白名單 3 個資料夾')
  assert.equal(catSummary('update', { autoCheck: true }), '自動檢查：開')
  assert.equal(catSummary('about', { version: '0.1.9' }), '版本 0.1.9')
})

test('對話框元件還在（開新夥伴失敗提示用）：只有 Esc 會關；別的元件已處理過的 Esc 不重複處理', () => {
  assert.equal(closesDialog({ key: 'Escape' }), true)
  assert.equal(closesDialog({ key: 'Enter' }), false)
  assert.equal(closesDialog({ key: 'Escape', defaultPrevented: true }), false)
  assert.equal(closesDialog(null), false)
})

// ---------- 設定表單元件：用 Vue 真的轉成 HTML ----------
const fullState = () => ({
  status: 'online', hasUpload: false, avBusy: false, avMsg: '',
  notify: { toast: true, msg: true, nudge: true, file: true }, frame: 'custom', mode: 'merged', dpMode: 'left', toolbar: 'top', bubble: 'none', tabDim: 'device', groupDim: 'status',
  voice: { cfg: { tts_voice: '', tts_auto: false, stt_lang: 'zh', stt_model: 'base' }, enabled: true, voices: [{ id: 'v1', label: '曉曉' }], sttReady: false, installBusy: false, note: '尚未安裝' },
  accounts: {
    list: [{ email: 'a@b.c', plan: 'Max', current: true, saved: true }, { email: 'p@b.c', plan: '', current: false, saved: true }],
    current: { email: 'a@b.c', plan: 'Max', current: true, saved: true }, codexLine: 'x@openai.test · plus',
    busy: false, confirmDel: '', msg: '', trustOwn: false,
    remote: { node: 'W', devices: [{ key: 'W', label: '工作機' }], list: [{ vendor: 'claude', email: 'w@b.c', plan: 'pro', current: false }], loading: false, busy: false, msg: '' },
  },
  closeTo: 'tray', trayOk: true, autostart: { supported: true, on: false, busy: false },
  autoCheck: true, upd: { checking: false, installing: false, manual: '', status: { tone: 'ok', head: '已是最新版', lines: ['目前版本 9.9.9', '最後檢查：今天 14:03'] } },
  launch: { tools: [{ id: 'claude', label: 'Claude Code', installed: true, version: '2.0', installHint: '' }, { id: 'gemini', label: 'Gemini', installed: false, version: '', installHint: '先安裝 Gemini CLI' }], maxPerHour: 6, cwdText: 'D:/a\nD:/b' },
  usage: { loading: false, error: '', updated: '14:05', data: { empty: '', unpriced: '', priceLine: '價目依 Anthropic 官方公開定價（2026-10-22 抄錄）', periods: [{ key: 'today', label: '今天', cost: '$1.20', tokens: '3,000', messages: 2, detail: '輸入 1', models: [{ model: 'claude-opus-4-5', cost: '$1.20', tokens: '3,000', messages: 2, priced: true }] }] } },
  version: '9.9.9',
})
const render = async (catKey, st = fullState()) => {
  globalThis.Vue = Vue
  const app = Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey, meAv: 'data:image/png;base64,AAAA' }) })
  return renderToString(app)
}

test('設定表單：每一類都轉得出來，各類原本的項目都在', async () => {
  const want = {
    me: ['登入狀態', '尚未登入', '用 Google 登入', '用 GitHub 登入', '大頭貼', '選擇圖片', '移除，改回自動產生', '目前用的是自動產生的大頭貼。'],
    accounts: ['Claude 帳號', '使用中', '加入目前登入的帳號', '自動加入', '切換', '刪除', 'a@b.c', 'OpenAI（Codex）帳號', 'x@openai.test · plus', 'Gemini', '尚未支援', '遠端設備', 'w@b.c', '信任我自己的設備'],
    look: ['視窗外框', '視窗模式', '頭像模式', '工具列位置', '文字底色'],
    tabs: ['分頁依', '分組依'],
    notify: ['右下角通知', '通知聲音', '震動聲音', '收到檔案聲音'],
    voice: ['念出訊息的聲音', '收到新訊息自動念', '語音輸入的語言', '語音辨識模型', '下載語音辨識', '曉曉', '尚未安裝'],
    window: ['關閉視窗時', '登入時自動啟動 ASN'],
    launch: ['每小時開新夥伴上限', '工作資料夾白名單', 'Claude Code', '先安裝 Gemini CLI'],
    usage: ['重新整理', '不是帳單', '更新於 14:05', '今天', '約 $1.20', 'claude-opus-4-5', '價目依 Anthropic 官方公開定價'],
    update: ['自動檢查更新', '立即檢查', '已是最新版', '目前版本 9.9.9', '最後檢查：今天 14:03', '版本更新記錄'],
    about: ['版本 9.9.9'],
  }
  assert.deepEqual(Object.keys(want), SETTING_KEYS, '每一類都有檢查')
  for (const [key, words] of Object.entries(want)) {
    const html = await render(key)
    for (const w of words) assert.ok(html.includes(w), `${key} 少了「${w}」`)
    // 一次只顯示被點的那一類：別類的項目不會混進來
    for (const [other, ow] of Object.entries(want)) if (other !== key && other !== 'about') assert.ok(!html.includes(ow.at(-1)), `${key} 混進了 ${other} 的「${ow.at(-1)}」`)
  }
})

test('設定表單：照目前的值顯示（選中項、勾選、數字、文字）', async () => {
  const st = fullState()
  st.frame = 'native'; st.dpMode = 'right'; st.autostart.on = true; st.launch.maxPerHour = 9; st.hasUpload = true
  assert.match(await render('look', st), /<select[^>]*value="native"[^>]*aria-label="視窗外框"/)   // 伺服器端轉出來的選中值寫在 select 上
  assert.match(await render('look', st), /<select[^>]*value="right"[^>]*aria-label="頭像模式"/)
  assert.match(await render('window', st), /type="checkbox"[^>]*checked/)
  assert.match(await render('launch', st), /type="number"[^>]*value="9"/)
  assert.match(await render('launch', st), /D:\/a\nD:\/b|D:\/a&#10;D:\/b/)
  assert.ok((await render('me', st)).includes('目前用的是這台設備上傳的大頭貼。'))
  const off = fullState(); off.trayOk = false; off.autostart.supported = false; off.voice.enabled = false
  assert.ok((await render('window', off)).includes('建不起系統匣圖示'))
  assert.ok(!(await render('window', off)).includes('登入時自動啟動'))
  assert.ok((await render('voice', off)).includes('念出訊息要由維護者在後台啟用'))
})

test('設定表單：通知四個勾選照目前的值顯示', async () => {
  const st = fullState(); st.notify = { toast: false, msg: true, nudge: false, file: true }
  const html = await render('notify', st)
  const boxes = [...html.matchAll(/<input type="checkbox"([^>]*)>/g)].map(m => [/aria-label="([^"]+)"/.exec(m[1])[1], /\bchecked\b/.test(m[1])])
  assert.deepEqual(boxes, [['右下角通知', false], ['通知聲音', true], ['震動聲音', false], ['收到檔案聲音', true]])
  assert.ok(!html.includes('音效'))
})

test('設定表單：認不得的類別不顯示任何表單項目', async () => {
  const html = await render('nope')
  assert.ok(!/<select|<input|<textarea|<button/.test(html))
})

test('守門：元件送出的每個指令，樞紐的 applySetting 都接得住；元件裡 act 的每個 op 都在清單裡', () => {
  const comp = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  const used = new Set([...comp.matchAll(/act\('([a-zA-Z-]+)'/g)].map(m => m[1]))
  assert.deepEqual([...used].sort(), [...SETTING_OPS].sort(), '元件實際送出的 op 與 SETTING_OPS 一致')
  const hub = read('list.js')
  const fn = hub.slice(hub.indexOf('const applySetting'), hub.indexOf('const pushSettings'))
  for (const op of SETTING_OPS) assert.ok(fn.includes(`case '${op}'`), `applySetting 缺 ${op}`)
  assert.ok(fn.includes("case 'avatar-upload'"), '分離視窗裁好的大頭貼也由樞紐上傳')
})

test('守門：每個舊設定項目的行為綁定都還在（改走樞紐指令，存檔欄位不變）', () => {
  const hub = read('list.js')
  for (const k of ['setFrame(value)', 'setMode(value)', 'setTabDim(value)', 'saveVoice(value)', 'installFromSettings()', 'accounts.switchTo(value)', 'accounts.remove(value)', 'accounts.addCurrent()', 'accounts.remoteSwitch(', 'accounts.setTrust(',
    'setCloseTo(value)', 'setAutostart(', 'checkUpdate(true)', 'saveLaunchPrefs()', 'setLaunchCwdText(', 'removeAvatar()', 'notifyWith(notifyPrefs.value', 'normalizeDpMode(value)', 'normalizeBubble(value)']) {
    assert.ok(hub.includes(k), `樞紐缺 ${k}`)
  }
  // 存檔格式不變：還是這些欄位
  for (const f of ['notify: notifyPrefs.value', 'frame: frame.value', 'closeTo: closeTo.value', 'autoUpdate: autoCheck.value', 'tabDim: dims.tabDim', 'groupDim: dims.groupDim', 'winMode: ui.mode', 'dpMode: ui.dpMode', 'bubble: ui.bubble', 'toolbar: ui.toolbar', 'splitSize: sizes.split', 'mergedSize: sizes.merged']) {
    assert.ok(hub.includes(f), `存檔欄位 ${f}`)
  }
})

test('守門：設定不再用彈出對話框，點分類列表的一項就開設定聊天窗；設定頁本身只剩分類列表', () => {
  const html = read('list.html'), js = read('list.js')
  const list = /<div class="list cat-list"[\s\S]*?<\/ul>/.exec(html)[0]
  assert.ok(!/<select|<input|<textarea/.test(list), '設定頁本身沒有表單控制項')
  assert.ok(list.includes("openPanel('setting', c.key)") && list.includes('catSub(c.key)'))
  assert.ok(!/openSettingDlg|dlg\.kind|dlg\.key|closeDlg|dlgTitle/.test(html + js), '舊的對話框接線都拿掉了')
  // 對話框元件只剩開新夥伴失敗提示在用
  const uses = [...html.matchAll(/<asn-dialog v-if="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual(uses, ['modelDlg.open', 'deviceAcct.node', 'accounts.state.incoming.length', 'launchNotice.open'])   // 切換模型的確認框、右鍵切換某台的 Claude 帳號、別台要求切換帳號的確認框、開新夥伴失敗提示
  assert.match(js, /app\.component\('asn-dialog', AsnDialog\)/)
  // 整合模式右邊的設定窗用同一個元件
  assert.ok(html.includes('<settings-panel :st="settingsState"') && js.includes("app.component('settings-panel', SettingsPanel)"))
  assert.ok(read('panel.js').includes("app.component('settings-panel', SettingsPanel)"), '分離視窗用同一個元件')
})

test('守門：分離視窗不持有設定狀態或金鑰——只收快照、用 asn:set 下指令', () => {
  const panel = read('panel.js')
  assert.ok(panel.includes("listen('asn:settings'") && panel.includes("emit('asn:set'"))
  assert.ok(!/store\(|transport|relay_|invoke\(/.test(panel.replace(/^\/\/.*$/gm, '')), '視窗裡沒有存檔、收發室或 Rust 指令的呼叫')
  const hub = read('list.js')
  assert.ok(hub.includes("emit('asn:settings', settingsState.value)") && hub.includes("listen('asn:set'"))
})

test('開網址不用 explorer.exe（長網址會被當成路徑開成檔案總管），改用 ShellExecuteW', async () => {
  const fs = await import('node:fs')
  const lib = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  assert.ok(!lib.includes('Command::new("explorer.exe")'), '不能再用 explorer.exe 開網址')
  assert.ok(lib.includes('ShellExecuteW('))
})

test('守門：電腦設定第一頁——登入帳號資訊與我的名字同處、登出鈕獨立在最下面；帳號分類不再放登入狀態', () => {
  const src = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const me = src.slice(src.indexOf("catKey === 'me'"), src.indexOf("catKey === 'notify'"))
  const accts = src.slice(src.indexOf("catKey === 'accounts'"), src.indexOf("catKey === 'look'"))
  assert.ok(me.indexOf('<login-panel>') >= 0 && me.indexOf('<login-panel>') < me.indexOf('class="av-set"'), '登入狀態（含我的名字）在第一頁最前面')
  assert.ok(me.indexOf('<logout-panel>') > me.indexOf('class="np-set"'), '登出鈕在第一頁所有項目之後')
  assert.ok(!accts.includes('<login-panel>') && !accts.includes('<logout-panel>'), '帳號分類不再放登入狀態與登出')
  assert.ok(accts.includes('<cloud-invite-panel>') && accts.includes('Claude 帳號'), '帳號分類其他項目留在原位')
  const lp = fs.readFileSync(new URL('../ui/lib/login-panel.mjs', import.meta.url), 'utf8')
  assert.ok(lp.includes('LogoutPanel') && /logout-btn/.test(lp))
  assert.match(fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8'), /\.logout-set\{margin-top:3\d+px/)
})

test('守門：手機設置頁——帳號在名字下、版本與檢查更新同卡、登出獨立在最下面', () => {
  const html = fs.readFileSync(new URL('../ui/m.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const pg = html.slice(html.indexOf('<section class="m-pg" aria-label="設置">'))
  const nameAt = pg.indexOf('我的名字<input'), acctAt = pg.indexOf('{{ accountText }}'), verAt = pg.indexOf('{{ info.version }}'), updAt = pg.indexOf('檢查更新'), outAt = pg.indexOf('doLogout')
  const formEnd = pg.indexOf('</div>', nameAt)
  assert.ok(nameAt > 0 && acctAt > nameAt && pg.slice(nameAt, acctAt).indexOf('m-card') < 0, '帳號文字緊接在我的名字之後、同一張卡')
  assert.ok(formEnd > acctAt, '帳號文字與名字在同一個卡片內')
  assert.ok(updAt > 0 && verAt > updAt && pg.slice(updAt, verAt).indexOf('m-card') < 0, '版本號與檢查更新同一張卡')
  assert.ok(outAt > verAt && pg.slice(verAt, outAt).includes('class="m-logout"'), '登出鈕在版本卡之後、自成一塊')
  assert.match(fs.readFileSync(new URL('../ui/mobile.css', import.meta.url), 'utf8'), /\.m-logout\{[^}]*margin-top:(2[4-9]|[3-9]\d)px/)
})
