// #1763 T4：設定項目效果紀錄（test/golden/settings-effects.json）的守門測試。
// 真的比對要開瀏覽器（scripts/settings-effects.mjs，約 11 分鐘，掛在 asn-ui-shots.yml）；這支測試是不開瀏覽器的那一半：
//  1. golden 檔本身：格式、排序、不重複、沒有金鑰或真實帳號、每個設定分類（電腦 SETTING_CATS、手機 MOBILE_SETTING_KEYS）都有紀錄
//  2. 平台專屬標記：只有電腦有的分類全標「電腦專屬」；手機的項目不會被標成電腦專屬
//  3. SETTING_OPS 對照：電腦設定元件會送出的每個 op，不是已有控制項走過（golden 的 acts），就是明列在 UNDRIVEN 並寫原因；兩邊都不放就紅
//  4. 比對與正規化的純邏輯（改指令名會被抓到、時間被遮掉、預設值寫入被扣掉…）
//  5. 若設了 ASN_SETTINGS_EFFECTS_LATEST（指到 settings-effects.mjs --out 產生的 json），順便跟 golden 比
// 重錄 golden：ASN_GOLDEN_UPDATE=1 node scripts/settings-effects.mjs（只在「使用者看得到的效果」確定要改時用）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { MOBILE_SETTING_KEYS } from '../ui/lib/mobile-settings.mjs'
import { SETTING_CATS } from '../ui/lib/settings-cats.mjs'
import { SETTING_OPS } from '../ui/lib/settings-panel.mjs'
import { baselineMe, compareEffects, diffPrefs, diffStorage, dropNoise, entryId, findSecrets, maskTime, sortEntries, stripDefaultWrites } from '../scripts/settings-effects-lib.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const GOLDEN = path.join(root, 'test', 'golden', 'settings-effects.json')
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'))
const deskCats = SETTING_CATS.map(c => c.key)

// 電腦設定元件的 op 裡，T4 的效果紀錄沒有控制項走到的：分組寫原因（搬到該類的 PR 要先把它補進效果紀錄，見單第 4 章各 C 張的驗收）
export const UNDRIVEN = {
  '帳號頁的額度卡與重新登入流程：假後台沒有額度讀取器與多帳號卡的資料，頁面只畫得出「⋯」一顆按鈕': ['quota-refresh', 'quota-mm-add', 'quota-mm-remove', 'quota-copy', 'quota-close', 'quota-cancel', 'relogin-ask', 'relogin-yes', 'relogin-no', 'relogin-close', 'row-switch', 'pi-login', 'pi-setup-ask', 'pi-setup-install', 'pi-setup-cancel', 'pi-setup-remove'],
  '設備頁的排序與移除：拖放（dragstart／dragover／drop）與鍵盤上下鍵不是單純的點選或輸入，要另寫手勢操作': ['device-move', 'device-reorder', 'device-show', 'device-remove', 'device-restore'],
  '設備詳情更深一層的流程（改名輸入後確認、忘記、替換設備）：效果紀錄只追到第二層': ['device-rename', 'known-forget', 'replace-pick', 'replace-do', 'replace-keep'],
  '工作管理員（設備詳情→工作管理員→工作列上的動作）：第三層以上': ['tm-close', 'tm-ask', 'tm-cancel', 'tm-confirm', 'tm-wake', 'tm-adopt', 'tm-view', 'tm-handover', 'tm-restart-ask', 'tm-restart-cancel', 'tm-restart-confirm'],
  '本機橋接與系統整合選項（開機啟動、守護、橋接、終端服務、接管、遠端輸入）：要這台機器的支援旗標為真才會顯示，假環境不給': ['autostart', 'guard', 'guard-resume', 'bridge-launch', 'bridge-auto-resume', 'bridge-compact', 'bridge-compact-n', 'bridge-term-server', 'bridge-term-fetch-retry', 'bridge-screen-watch', 'bridge-perm-phone', 'bridge-mobile-view', 'bridge-remote-input', 'bridge-gemini-full-access', 'bridge-unaddressed', 'bridge-takeover', 'bridge-takeover-yes', 'bridge-takeover-no', 'askpass-copy'],
  '啟動設定的資料夾清單與安裝確認：要先有資料夾項目或偵測到可安裝的 AI 程式，假環境沒有': ['launch-cwd-remove', 'launch-cwd-suggest', 'launch-install-ask', 'launch-install-yes', 'launch-install-no'],
  '個人頁的大頭貼移除：要先有大頭貼才會出現': ['avatar-remove'],
}
const undriven = Object.values(UNDRIVEN).flat()
const driven = new Set(golden.entries.flatMap(e => e.acts ?? []))

test('golden 檔：格式、排序、id 不重複', () => {
  assert.equal(golden.version, 1)
  assert.ok(Array.isArray(golden.entries) && golden.entries.length >= 150, `項目數太少：${golden.entries?.length}`)
  const ids = golden.entries.map(entryId)
  assert.equal(new Set(ids).size, ids.length, '有重複的項目 id')
  assert.deepEqual(golden.entries.map(entryId), sortEntries(golden.entries).map(entryId), '項目沒有照 id 排序')
  for (const e of golden.entries) {
    assert.ok(['desk', 'phone'].includes(e.platform), entryId(e))
    assert.ok(Array.isArray(e.calls) && Array.isArray(e.prefs) && Array.isArray(e.storage), entryId(e))
    for (const c of e.calls) assert.ok(typeof c.cmd === 'string' && c.cmd, `${entryId(e)} 有空的指令名`)
  }
})

test('golden 檔：沒有金鑰、token、真實帳號（假資料也只用 example.*）', () => {
  assert.deepEqual(findSecrets(JSON.stringify(golden)), [])
  assert.deepEqual(findSecrets('{"email":"someone@gmail.com"}').length > 0, true, '掃描器自己要抓得到真實信箱')
  assert.deepEqual(findSecrets('{"token":"sk-abcdefghijklmnop1234"}').length > 0, true, '掃描器自己要抓得到金鑰')
})

test('golden 檔：沒有會變的值（時間已遮成 <現在>，不應有現在±30 天的毫秒數）', () => {
  const now = Date.now()
  const bad = []
  const walk = (v, where) => {
    if (typeof v === 'number' && v > 1e11 && Math.abs(v - now) < 30 * 24 * 3600 * 1000) bad.push(where)
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`)
  }
  for (const e of golden.entries) walk(e.calls, entryId(e))
  assert.deepEqual(bad, [])
})

test('每個設定分類都有紀錄：電腦 SETTING_CATS、手機 MOBILE_SETTING_KEYS', () => {
  const have = p => new Set(golden.entries.filter(e => e.platform === p).map(e => e.cat))
  assert.deepEqual(deskCats.filter(k => !have('desk').has(k)), [], '電腦缺的分類')
  assert.deepEqual(MOBILE_SETTING_KEYS.filter(k => !have('phone').has(k)), [], '手機缺的分類')
  assert.deepEqual([...have('desk')].filter(k => !deskCats.includes(k)), [], '紀錄裡有不存在的電腦分類')
  assert.deepEqual([...have('phone')].filter(k => !MOBILE_SETTING_KEYS.includes(k)), [], '紀錄裡有不存在的手機分類')
})

test('平台專屬標記：只有電腦有的分類全標電腦專屬；手機的項目不會被標成電腦專屬', () => {
  const deskOnlyCats = deskCats.filter(k => !MOBILE_SETTING_KEYS.includes(k))
  assert.ok(deskOnlyCats.length >= 4, `電腦專屬的分類：${deskOnlyCats}`)
  for (const e of golden.entries) {
    if (e.platform === 'desk' && deskOnlyCats.includes(e.cat)) assert.equal(e.platformOnly, 'desk', entryId(e))
    if (e.platform === 'phone') assert.ok(e.platformOnly === null || e.platformOnly === 'phone', entryId(e))
    if (e.platform === 'desk') assert.ok(e.platformOnly === null || e.platformOnly === 'desk', entryId(e))
  }
  assert.ok(golden.entries.some(e => e.platform === 'phone' && e.platformOnly === 'phone'), '手機也要有專屬項目（例如震動）')
  assert.ok(golden.entries.some(e => e.platformOnly === null), '要有兩邊都有的項目（例如外觀）')
})

test('SETTING_OPS 對照：每個 op 不是已被控制項走過，就是明列在 UNDRIVEN 並寫了原因', () => {
  assert.equal(new Set(undriven).size, undriven.length, 'UNDRIVEN 有重複的 op')
  const unknown = undriven.filter(o => !SETTING_OPS.includes(o))
  assert.deepEqual(unknown, [], 'UNDRIVEN 裡有不在 SETTING_OPS 的 op（改名或拿掉了？）')
  const both = undriven.filter(o => driven.has(o))
  assert.deepEqual(both, [], '這些 op 已經有控制項走過，請從 UNDRIVEN 拿掉')
  const neither = SETTING_OPS.filter(o => !driven.has(o) && !undriven.includes(o))
  assert.deepEqual(neither, [], '這些 op 既沒有紀錄也沒有說明原因：新增設定項目請補效果紀錄（重錄 golden）或寫進 UNDRIVEN')
  const ghost = [...driven].filter(o => !SETTING_OPS.includes(o))
  assert.deepEqual(ghost, [], '紀錄裡有 SETTING_OPS 沒有的 op')
  for (const [why, ops] of Object.entries(UNDRIVEN)) assert.ok(why.length > 10 && ops.length, '每組都要有原因與 op')
})

// ---- 純邏輯 ----
const fx = (cmd = 'set_frame', extra = {}) => ({ platform: 'desk', cat: 'look', kind: 'select', label: '視窗外框', nth: 1, input: '選', calls: [{ cmd, args: { v: 1 } }], prefs: [], storage: [], dialog: null, platformOnly: 'desk', ...extra })

test('比對：改指令名、改參數、少一筆、多一筆都會被抓到；內部 op 名（acts）不參與比對', () => {
  const g = { entries: [fx(), fx('x', { label: '別的' })] }
  assert.equal(compareEffects(g, { entries: [fx(), fx('x', { label: '別的' })] }).ok, true)
  const renamed = compareEffects(g, { entries: [fx('set_frame2'), fx('x', { label: '別的' })] })
  assert.equal(renamed.ok, false); assert.equal(renamed.changed.length, 1)
  const argd = compareEffects(g, { entries: [fx('set_frame', { calls: [{ cmd: 'set_frame', args: { v: 2 } }] }), fx('x', { label: '別的' })] })
  assert.equal(argd.ok, false)
  assert.deepEqual(compareEffects(g, { entries: [fx()] }).missing.length, 1)
  assert.deepEqual(compareEffects(g, { entries: [...g.entries, fx('y', { label: '新的' })] }).extra.length, 1)
  assert.equal(compareEffects(g, { entries: [fx('set_frame', { acts: ['frame'] }), fx('x', { label: '別的' })] }).ok, true)
  assert.equal(compareEffects(g, { entries: [fx('set_frame', { prefs: [{ path: 'frame', from: null, to: 'native' }] }), fx('x', { label: '別的' })] }).ok, false, 'prefs 差異不同要紅')
  assert.equal(compareEffects(g, { entries: [fx('set_frame', { storage: [{ key: 'asnSkin', from: 'a', to: 'b' }] }), fx('x', { label: '別的' })] }).ok, false, 'localStorage 差異不同要紅')
})

test('正規化：現在附近的時間（毫秒、ISO）遮成 <現在>，其他值不動，鍵排序固定', () => {
  const now = 1_800_000_000_000
  assert.deepEqual(maskTime({ b: now + 5000, a: new Date(now - 1000).toISOString(), c: 1763000000000, d: 3, e: 'x' }, now), { a: '<現在>', b: '<現在>', c: 1763000000000, d: 3, e: 'x' })
  assert.deepEqual(Object.keys(maskTime({ z: 1, a: 2 }, now)), ['a', 'z'])
})

test('prefs 差異：只列操作前後真的變了的欄位；操作前的狀態含不操作時就寫出的預設值', () => {
  const initial = { winMode: 'merged', skin: 'aero' }
  const base = [{ cmd: 'settings_patch', args: { name: 'me', patch: { bubble: 'none' } } }]
  const before = baselineMe(initial, base)
  assert.deepEqual(before, { winMode: 'merged', skin: 'aero', bubble: 'none' })
  const op = [{ cmd: 'settings_patch', args: { name: 'me', patch: { bubble: 'none', skin: 'line', notify: { toast: false } } } }]
  assert.deepEqual(diffPrefs(before, op), [{ path: 'notify.toast', from: null, to: false }, { path: 'skin', from: 'aero', to: 'line' }])
  assert.deepEqual(diffPrefs(before, []), [])
})

test('localStorage 差異與背景底噪', () => {
  assert.deepEqual(diffStorage({ a: '1', b: '2' }, { a: '1', b: '3', c: '4' }), [{ key: 'b', from: '2', to: '3' }, { key: 'c', from: null, to: '4' }])
  const c = (cmd, v) => ({ cmd, args: { v } })
  // 固定底噪指令一律扣掉；底噪裡有的「指令＋參數」容許多一次的計時誤差，超出才算效果
  assert.deepEqual(dropNoise([c('local_windows', 1), c('relay_list', 1), c('relay_list', 1), c('relay_list', 1), c('x', 1)], [c('relay_list', 1)]), [c('relay_list', 1), c('x', 1)])
})

test('預設值跟著寫：同一平台多個控制項的存檔裡值都一樣（或占過半）的欄位不算那個控制項的效果', () => {
  const p = (path, to) => ({ path, from: null, to })
  const e = (label, prefs) => ({ platform: 'desk', cat: 'look', kind: 'select', label, nth: 1, prefs })
  const out = stripDefaultWrites([e('a', [p('x', 1), p('skin', 'aero')]), e('b', [p('x', 1), p('skin', 'aero')]), e('c', [p('x', 1), p('skin', 'line')]), e('d', [p('x', 2), p('skin', 'aero')])])
  assert.deepEqual(out.map(r => r.prefs.map(q => `${q.path}=${q.to}`)), [[], [], ['skin=line'], ['x=2']])
})

const latestPath = process.env.ASN_SETTINGS_EFFECTS_LATEST
test('最新量測跟 golden 一致（要設 ASN_SETTINGS_EFFECTS_LATEST 才跑）', { skip: !latestPath && '沒有最新量測結果（先 node scripts/settings-effects.mjs --out <資料夾>，再把 ASN_SETTINGS_EFFECTS_LATEST 指到 <資料夾>/settings-effects.json）' }, () => {
  const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'))
  const r = compareEffects(golden, latest)
  assert.deepEqual({ missing: r.missing, extra: r.extra, changed: r.changed.map(c => c.id) }, { missing: [], extra: [], changed: [] })
})
