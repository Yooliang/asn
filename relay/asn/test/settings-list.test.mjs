// #1853 設定值清單（docs/設定值清單.md）的守門測試。
// 清單要列出「電腦設定頁會送出的每個指令」「手機偏好的每個鍵」「設定頁的每個分類」；
// 這裡的標準答案一律從程式來源直接取得（import 或讀原始碼），不在測試裡手抄一份鍵名：
// 新增設定沒登記就變紅；清單裡寫了程式已經沒有的也變紅；預設值欄跟程式對不上也變紅；
// 「誰會讀它」的錨點（檔案＋一段程式內容）在檔案裡找不到也變紅；平台欄空白或「無」沒寫原因也變紅。
// 檢查核心在 settings-list-check.mjs（純函式）；本檔下半段是「還原驗證」：把清單故意改壞，確認每一種都會報錯。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SETTING_OPS } from '../ui/lib/settings-panel.mjs'
import { SETTING_CATS } from '../ui/lib/settings-cats.mjs'
import { MOBILE_SETTING_KEYS } from '../ui/lib/mobile-settings.mjs'
import { DEFAULT_PREFS, normalizePrefs } from '../ui/lib/mobile.mjs'
import { AGENT_INSTALL_UI } from '../ui/lib/flags.mjs'
import { DEFAULT_DIMS, DIMS } from '../ui/lib/dims.mjs'
import { DEFAULT_SKIN, SKIN_LABEL } from '../ui/lib/skin.mjs'
import { FRAME_LABEL, CLOSE_LABEL, NOTIFY_ITEMS, normalizeFrame, normalizeClose, notifyFromSaved } from '../ui/lib/prefs.mjs'
import { MODE_LABEL, DP_LABEL, BUBBLE_LABEL, TOOLBAR_LABEL, DEFAULT_LOOK, normalizeMode } from '../ui/lib/merge.mjs'
import { DEFAULT_CFG, STT_LANG_LABEL, STT_MODEL_LABEL } from '../ui/lib/voice-prefs.mjs'
import { normalizeLaunchPrefs } from '../ui/lib/launch-prefs.mjs'
import { autoCheckFromSaved } from '../ui/lib/update.mjs'
import { normalizeNowPlaying } from '../ui/lib/now-playing.mjs'
import { AI_WAKE_LIMIT_DEFAULT } from '../ui/lib/ai-wake-limit.mjs'
import { LAUNCH_INSTALL_BTN } from '../ui/lib/flags.mjs'
import { RESUME_WAIT_MS, ASN_RESTART_WAIT_MS } from '../ui/lib/task-manager.mjs'
import { COLS, bridgeDefault, checkList, colOf, diffOps, dropRow, editRow, fmtErrors, parseList, parsePlatform, rustConst, scanOpLiterals } from './settings-list-check.mjs'

export { parseList }

const ROOT = new URL('../', import.meta.url)
const DOC = new URL('../../../docs/設定值清單.md', import.meta.url)
const readFile = rel => { const f = new URL(rel, ROOT); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null }

const doc = fs.readFileSync(DOC, 'utf8')
const BRIDGE = 'src-tauri/src/bridge/mod.rs'

// 預設值要比對的項目：cell 是對「預設值」欄的要求；code 是「程式裡真的有這個預設」的證據（檔案＋正規式）。
// 比不了的列，在清單的預設值欄標〔人工：原因〕（見檢查核心）。
const dimLabel = k => DIMS.find(d => d.key === k).label
const bridgeOn = (token, field) => ({ token, startsWith: bridgeDefault(readFile(BRIDGE), field) === 'false' ? '開' : '關', code: [[BRIDGE, new RegExp(`impl Default for BridgeSettings[\\s\\S]*?\\b${field}: false`)]] })
const defaults = () => {
  const n = notifyFromSaved({})
  assert.ok(NOTIFY_ITEMS.every(i => n[i.key] === true), '通知預設不是全開了，清單要改')
  const lp = normalizeLaunchPrefs(null)
  return [
    { token: 'tabDim', includes: [dimLabel(DEFAULT_DIMS.tabDim)] },
    { token: 'groupDim', includes: [dimLabel(DEFAULT_DIMS.groupDim)] },
    { token: 'skin', includes: [SKIN_LABEL[DEFAULT_SKIN]] },
    { token: 'frame', includes: [FRAME_LABEL[normalizeFrame(undefined)]] },
    { token: 'closeTo', includes: [CLOSE_LABEL[normalizeClose(undefined)]] },
    { token: 'mode', includes: [MODE_LABEL[normalizeMode(undefined)]] },
    { token: 'dpMode', includes: [DP_LABEL[DEFAULT_LOOK.dpMode]] },
    { token: 'bubble', includes: [BUBBLE_LABEL[DEFAULT_LOOK.bubble]] },
    { token: 'toolbar', includes: [TOOLBAR_LABEL[DEFAULT_LOOK.toolbar]] },
    { token: 'notify', startsWith: '全開' },
    { token: 'voice-save', includes: [STT_LANG_LABEL[DEFAULT_CFG.stt_lang], STT_MODEL_LABEL[DEFAULT_CFG.stt_model], `自動念：${DEFAULT_CFG.tts_auto ? '開' : '關'}`] },
    { token: 'launch-max', startsWith: String(lp.maxPerHour), includes: [`同為 ${lp.maxPerHour}`], code: [['src-tauri/src/launch/config.rs', new RegExp(`const DEFAULT_MAX_PER_HOUR: u32 = ${lp.maxPerHour};`)]] },
    { token: 'app.launch-display', includes: [lp.launchDisplay === 'background' ? '背景' : '前景'] },
    { token: 'autoCheck', startsWith: autoCheckFromSaved(undefined) ? '開' : '關' },
    { token: 'now-playing', startsWith: normalizeNowPlaying(undefined) ? '開' : '關' },
    { token: 'app.ai-wake-limit', startsWith: String(AI_WAKE_LIMIT_DEFAULT) },
    { token: 'app.me-status', includes: ['在線'], code: [['ui/list.js', /reactive\(\{ psm: '', status: 'online'/]] },
    { token: 'app.me-psm', startsWith: '空白', code: [['ui/list.js', /reactive\(\{ psm: '', status: 'online'/]] },
    { token: 'known-login-ok', startsWith: '關', code: [['src-tauri/src/device_id.rs', /login_ok: false/]] },
    { token: 'acct-allow-switch', startsWith: '開', code: [['src-tauri/src/acct_remote.rs', /remote_allow_switch\.unwrap_or\(p\.remote_trust_own \|\| p\.remote_trust_signed\)/]] },
    { token: 'quota-source', startsWith: '關', code: [['src-tauri/src/quota_readers.rs', /一律當成全關/]] },
    { token: 'quota-mm-add', includes: [`最多 ${rustConst(readFile('src-tauri/src/quota_readers.rs'), 'MAX_MINIMAX')} 個`] },
    { token: 'launch-install-ask', includes: [`LAUNCH_INSTALL_BTN = ${LAUNCH_INSTALL_BTN}`] },
    { token: 'bridge-launch', startsWith: '程式預設關', code: [[BRIDGE, /impl Default for BridgeSettings[\s\S]*?\ballow_remote_launch: false/], ['src-tauri/src/first_run.rs', /allow_remote_launch = true/]] },
    bridgeOn('bridge-auto-resume', 'auto_resume_off'),
    bridgeOn('bridge-screen-watch', 'screen_watch_off'),
    bridgeOn('bridge-perm-phone', 'perm_phone_off'),
    bridgeOn('bridge-mobile-view', 'mobile_view_off'),
    bridgeOn('bridge-remote-input', 'remote_input_off'),
    { ...bridgeOn('bridge-compact', 'compact_handoff_off'), includes: [`${rustConst(readFile('src-tauri/src/bridge/compact.rs'), 'N_DEFAULT')} 次`] },
    { token: 'bridge-unaddressed', startsWith: '空白', code: [[BRIDGE, /impl Default for BridgeSettings[\s\S]*?\bunaddressed_to: String::new\(\)/]] },
    // 設備順序、顯示、移除：存檔欄位讀進來都是 normalizeKeys，沒存過就是空陣列
    ...['device-move:deviceOrder', 'device-show:deviceShown', 'device-remove:deviceRemoved', 'device-restore:deviceRemoved'].map(s => {
      const [token, field] = s.split(':')
      return { token, startsWith: '空', code: [['ui/lib/device-order.mjs', new RegExp(`${field}: normalizeKeys\\(saved\\?\\.${field}\\)`)]] }
    }),
    { token: 'bridge-term-server', includes: ['Windows 開', 'Linux 關'], code: [[BRIDGE, /impl Default for BridgeSettings[\s\S]*?\bterm_server_off: false, term_server_on: false/]] },
    { token: 'launch-cwd-add', startsWith: lp.cwdAllow.length === 0 ? '空清單' : '' },
    // 工作管理員重啟後的等待時間，清單寫的秒數要等於常數
    { token: 'tm-open', includes: [`最多等 ${RESUME_WAIT_MS / 1000} 秒`, `最多等 ${ASN_RESTART_WAIT_MS / 1000} 秒`] },
    { token: 'flag.LOG_REPORT_ROOM', startsWith: '空白', code: [['src-tauri/src/log_report.rs', /pub const RECIPIENT_ROOM: &str = "";/]] },
  ]
}

const truth = () => ({
  ops: SETTING_OPS,
  cats: SETTING_CATS,
  mobileCats: MOBILE_SETTING_KEYS,
  prefs: { keys: [...new Set([...Object.keys(DEFAULT_PREFS), ...Object.keys(normalizePrefs({}))])], defaults: normalizePrefs({}), skinLabel: SKIN_LABEL[normalizePrefs({}).skin] },
  flags: { AGENT_INSTALL_UI },
  defaults: defaults(),
  readFile,
})

const T = truth()
const real = checkList(doc, T)
const kinds = (text, t = T) => new Set(checkList(text, t).errors.map(e => e.kind))

test('#1853 設定值清單：結構、指令、手機偏好、分類、旗標、預設值、平台欄、錨點全部對得上程式', () => {
  assert.equal(real.errors.length, 0, `\n${fmtErrors(real.errors)}`)
})

test('#1853 手機偏好至少有 6 個鍵（防止取鍵的辦法壞了卻沒人發現）', () => {
  assert.ok(T.prefs.keys.length >= 6)   // 6 個：震動×2、自動檢查、推播、外觀、釘選（#1776 拿掉 ghRefs）
})

test('#1853 checkList 輸出 { token, cat, platforms }，給之後的合約表（#1763）用', () => {
  const e = real.entries.find(x => x.token === 'skin')
  assert.equal(e.cat, 'look')
  assert.equal(e.platforms.desktop.has, true)
  assert.equal(e.platforms.mobile.has, true)
  assert.equal(e.platforms.web.has, false)
  assert.ok(e.platforms.web.reason.length >= 4)
  const f = real.entries.find(x => x.token === 'frame')
  assert.equal(f.platforms.mobile.has, false)
  assert.ok(f.platforms.mobile.reason.includes('外框'))
  assert.ok(real.entries.length >= 100)
  for (const x of real.entries) assert.ok(x.cat, `${x.token} 沒有分類`)
})

// ---- 指令：SETTING_OPS 跟元件原始碼實際送出的一致 ----
// 工作管理員的 tm-* 看起來像動態組字，其實都是 task-tree-view.mjs 裡的字面（$emit('act', 'tm-ask', …)），
// 所以直接掃原始碼就能列舉，不必把正式程式改成常數陣列。
test('#1853 SETTING_OPS 跟元件原始碼實際送出的指令一致（含 tm-* 七個）', () => {
  const src = f => readFile(f) ?? assert.fail(`缺 ${f}`)
  const sent = new Set([
    ...scanOpLiterals(src('ui/lib/settings-panel.mjs')),
    ...scanOpLiterals(src('ui/lib/task-tree-view.mjs')),
    ...scanOpLiterals(src('ui/lib/quota-readers.mjs'), { opProps: true }),   // 帳號卡「⋯」選單的項目是 { op: '…' } 物件
  ])
  for (const op of ['tm-handover', 'tm-ask', 'tm-adopt', 'tm-view', 'tm-restart-ask', 'tm-restart-cancel', 'tm-restart-confirm']) assert.ok(sent.has(op), `掃不到 ${op}`)
  assert.deepEqual(diffOps(sent, SETTING_OPS), [])
})

test('#1853 每個設定指令在名單視窗的樞紐（list.js）都有 case', () => {
  const hub = readFile('ui/list.js')
  const miss = SETTING_OPS.filter(op => !hub.includes(`case '${op}':`))
  assert.deepEqual(miss, [], '這些指令元件會送、樞紐卻沒接')
})

// ---- 還原驗證：把清單（或標準答案）故意改壞，每一種都要報出對應的錯 ----
test('還原驗證：刪掉一列（指令、手機偏好、分類）→ 報缺列', () => {
  assert.ok(kinds(dropRow(doc, 'autostart')).has('op-missing'))
  assert.ok(kinds(dropRow(doc, 'prefs.push')).has('pref-missing'))
  assert.ok(kinds(dropRow(doc, 'cat.voice')).has('cat-missing'))
})

test('還原驗證：清單多寫一個程式沒有的指令／偏好／分類 → 報多出來', () => {
  const bad = (text, extra) => text.replace('| `autostart` |', `${extra}\n| \`autostart\` |`)
  const row = tok => `| \`${tok}\` | x | 開關 | 關 | 這台自己 | 有 | 無：手機沒有 | 無：尚無網頁版 | 《ui/list.js#case 'skin':》 |`
  assert.ok(kinds(bad(doc, row('not-a-real-op'))).has('op-extra'))
  assert.ok(kinds(bad(doc, row('prefs.ghost'))).has('pref-extra'))
  assert.ok(kinds(bad(doc, row('cat.ghost'))).has('cat-extra'))
})

test('還原驗證：改掉一個預設值 → 報預設值不符（標籤比對、程式比對、布林、數字各一種）', () => {
  const cell = tok => colOf(parseList(doc).find(r => r.tokens.includes(tok)), '預設值')
  assert.ok(kinds(editRow(doc, 'tabDim', '預設值', '不是任何選項')).has('default'))
  assert.ok(kinds(editRow(doc, 'launch-max', '預設值', cell('launch-max').replace(/^6/, '7'))).has('default'))
  assert.ok(kinds(editRow(doc, 'bridge-screen-watch', '預設值', cell('bridge-screen-watch').replace(/^開/, '關'))).has('default'))
  assert.ok(kinds(editRow(doc, 'prefs.push', '預設值', '關')).has('pref-default'))
  assert.ok(kinds(editRow(doc, 'prefs.skin', '預設值', '沒有這個外觀')).has('pref-default'))
  assert.ok(kinds(editRow(doc, 'flag.AGENT_INSTALL_UI', '預設值', '目前：開（假的）')).has('flag'))
})

test('還原驗證：程式端的預設改了（標準答案改掉）→ 清單變紅', () => {
  assert.ok(kinds(doc, { ...T, defaults: [...T.defaults, { token: 'frame', includes: ['不存在的標籤'] }] }).has('default'))
  assert.ok(kinds(doc, { ...T, readFile: rel => (rel === BRIDGE ? '' : readFile(rel)) }).has('default-code'))
})

test('還原驗證：預設值沒比對、也沒標〔人工：原因〕→ 報未涵蓋；標了但原因空白也不行', () => {
  assert.ok(kinds(editRow(doc, 'autostart', '預設值', '關')).has('default-uncovered'))
  assert.ok(kinds(editRow(doc, 'autostart', '預設值', '關〔人工：〕')).has('default-uncovered'))
  assert.equal(kinds(editRow(doc, 'autostart', '預設值', '關〔人工：系統登錄值，程式沒有預設〕')).has('default-uncovered'), false)
})

test('還原驗證：清空某個平台欄、平台欄只寫「無」、原因寫「同上」、亂寫 → 各報錯', () => {
  assert.ok(kinds(editRow(doc, 'frame', COLS.mobile, '')).has('platform-empty'))
  assert.ok(kinds(editRow(doc, 'frame', COLS.web, '')).has('platform-empty'))
  assert.ok(kinds(editRow(doc, 'frame', COLS.mobile, '無')).has('platform-bad'))
  assert.ok(kinds(editRow(doc, 'frame', COLS.web, '無')).has('platform-bad'))
  assert.ok(kinds(editRow(doc, 'frame', COLS.mobile, '無（同上）')).has('platform-bad'))
  assert.ok(kinds(editRow(doc, 'frame', COLS.desktop, '也許')).has('platform-bad'))
  assert.ok(kinds(editRow(doc, 'cat.voice', COLS.web, '無')).has('platform-bad'))
})

test('還原驗證：平台欄規則本身（parsePlatform）', () => {
  assert.equal(parsePlatform('有').has, true)
  assert.equal(parsePlatform('有（只有 Windows）').ok, true)
  assert.equal(parsePlatform('無：手機沒有系統匣').reason, '手機沒有系統匣')
  assert.equal(parsePlatform('無（手機沒有系統匣）').reason, '手機沒有系統匣')
  for (const s of ['', '無', '無：', '無（同上）', '無：同上', '沒有']) assert.equal(parsePlatform(s).ok, false, s)
})

test('還原驗證：錨點——內容對不上、檔案不存在、沒寫錨點、還在用行號 → 各報錯', () => {
  assert.ok(kinds(editRow(doc, 'skin', '誰會讀它', '《ui/lib/skin.mjs＃這段話絕對不在檔案裡》')).has('anchor-miss'))
  assert.ok(kinds(editRow(doc, 'skin', '誰會讀它', '《ui/lib/no-such-file.mjs＃applySkin》')).has('anchor-file'))
  assert.ok(kinds(editRow(doc, 'skin', '誰會讀它', '每個視窗開起來先套樣式')).has('anchor-none'))
  assert.ok(kinds(editRow(doc, 'skin', '誰會讀它', '《ui/lib/skin.mjs＃applySkin》ui/lib/skin.mjs:15')).has('anchor-linenum'))
  assert.ok(kinds(editRow(doc, 'skin', '預設值', '復古 Aero（ui/lib/skin.mjs:8）')).has('anchor-linenum'))
})

test('還原驗證：錨點的真實案例——bridge-launch 的預設位置曾經寫成 mod.rs:110，實際在 Default 初值', () => {
  const r = parseList(doc).find(x => x.tokens.includes('bridge-launch'))
  assert.ok(colOf(r, '預設值').includes('《src-tauri/src/bridge/mod.rs＃'))
  assert.ok(readFile(BRIDGE).includes(colOf(r, '預設值').match(/《src-tauri\/src\/bridge\/mod\.rs＃([^》]+)》/)[1]))
})

test('還原驗證：表格結構——欄數不對、標記重複、列數太少 → 報錯', () => {
  assert.ok(kinds(doc.replace('| `autostart` | 登入時自動啟動 ASN | 開關 |', '| `autostart` | 登入時自動啟動 ASN |')).has('row-shape'))
  assert.ok(kinds(doc.replace('| `autostart` |', '| `autostart` `skin` |')).has('dup'))
  assert.ok(kinds('| 指令／鍵 | 預設值 |\n|---|---|\n| `skin` | 復古 |').has('row-count'))
})

test('還原驗證：手機欄跟 MOBILE_SETTING_KEYS 不一致、標題不同、電腦欄不是「有」→ 報錯', () => {
  assert.ok(kinds(doc, { ...T, mobileCats: [...MOBILE_SETTING_KEYS, 'voice'] }).has('cat-mobile'))
  assert.ok(kinds(doc, { ...T, mobileCats: MOBILE_SETTING_KEYS.filter(k => k !== 'me') }).has('cat-mobile'))
  assert.ok(kinds(editRow(doc, 'cat.me', '標題', '別的標題')).has('cat-title'))
  assert.ok(kinds(editRow(doc, 'cat.me', COLS.desktop, '無：假的原因')).has('cat-desktop'))
})

test('還原驗證：元件多送、少送指令（掃原始碼）→ diffOps 報錯', () => {
  assert.deepEqual(diffOps(scanOpLiterals("act('a'); $emit('act', 'b', 1); { op: 'c' }", { opProps: true }), ['a', 'b', 'c']), [])
  assert.deepEqual(diffOps(scanOpLiterals("act('a'); { op: 'c' }; emits: ['act', 'avatar-file']"), ['a']), [], 'op: 屬性與 emits 宣告不算送出的指令（沒開 opProps）')
  assert.deepEqual(diffOps(scanOpLiterals("act('a'); act('zz')"), ['a']).map(e => e.kind), ['ops-not-registered'])
  assert.deepEqual(diffOps(scanOpLiterals("act('a')"), ['a', 'gone']).map(e => e.kind), ['ops-not-sent'])
})

test('還原驗證：#2163 環境變數節、#2321 前端旗標節（表頭不含「指令／鍵」）不被解析、不互相干擾', () => {
  const extra = `${doc}\n\n## 前端旗標\n\n| 旗標 | 預設 | 用途 |\n|---|---|---|\n| \`flag.AGENT_INSTALL_UI\` | 關 | 重列也不算重複 |\n`
  assert.equal(parseList(extra).length, parseList(doc).length)
  assert.equal(kinds(extra).has('dup'), false)
  assert.ok(parseList(doc).every(r => !r.tokens.some(t => t.startsWith('ASN_'))), '環境變數節的名稱不能被解析成設定標記')
})
