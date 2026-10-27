// 各引擎目前能不能「關閉」「切換模型」（管理夥伴視窗的選單，ui/lib/partner-ops.mjs 的 menuItems）。
// 這份是「現況盤點」：用測試把表釘住，哪天有人改了行為（不管好壞）就會看到。表與證據見對應的 issue。
// 電腦端對應：bridge/partner_ops.rs 的 execute——ACP 工作者只做 info／close（停止本次執行）／restart／handover，其餘回「這類夥伴不支援」；
// 非 ACP 的一律走 find_target，只會找 ~/.claude/sessions 裡的 Claude 互動視窗，所以 Codex／pi 即使畫面放行也會回「找不到這個夥伴的 Claude 視窗」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { MENU_KEYS, MODEL_RE, REASON, buildOpRequest, menuItems, opFormError, partnerEngine } from '../ui/lib/partner-ops.mjs'
import { machinesByNode } from '../ui/lib/mobile-launch.mjs'

const MACH = machinesByNode({ machines: [{ node: 'H', launcher: { profiles: [{ id: 'claude' }], cwd_allow: ['D:/x'] }, online: true }] })
const ctx = { machines: MACH, loaded: true, signedIn: true, asn: {} }
const P = (agent, engine, extra = {}) => ({ id: `H/${agent}`, node: 'H', agent, nick: agent, status: 'online', engine, kind: engine, device: '家用機', ...extra })
const ok = (f, key) => menuItems(f, ctx).find(i => i.key === key)

// 引擎 → { close, model, restart, handover }（現況）
const MATRIX = [
  ['claude 視窗', P('小甲', 'claude'), { close: true, model: true, restart: false, handover: true }],
  ['codex 視窗', P('小乙', 'codex'), { close: false, model: false, restart: false, handover: false }],
  ['gemini 背景工作者（ACP）', P('Gemini', 'gemini', { kind: undefined }), { close: true, model: false, restart: true, handover: true }],
  ['agy 背景工作者（ACP）', P('Agy', 'agy', { kind: undefined }), { close: true, model: false, restart: true, handover: true }],
  ['pi 視窗（開放切換模型與關閉）', P('小丙', 'pi'), { close: true, model: true, restart: false, handover: false }],
  ['grok 雲端代理（engine=grok, kind=grok）', P('ASN-開發', 'grok'), { close: false, model: false, restart: false, handover: false }],
]
for (const [label, friend, want] of MATRIX) {
  test(`現況：${label} 的 關閉／切換模型／重開／接班換手 ＝ ${JSON.stringify(want)}`, () => {
    const got = Object.fromEntries(['close', 'model', 'restart', 'handover'].map(k => [k, ok(friend, k).ok]))
    assert.deepEqual(got, want)
    assert.deepEqual(menuItems(friend, ctx).map(i => i.key), MENU_KEYS, '項目固定不變')
  })
}

test('現況：不能用的項目都有寫明原因（Codex＝尚未實機驗證；pi 開放切換模型與關閉，其餘各有說明；雲端＝沒有視窗）', () => {
  assert.equal(ok(P('小乙', 'codex'), 'close').reason, REASON.otherEngine)
  assert.match(REASON.otherEngine, /尚未實機驗證，暫不開放/)
  const piItems = menuItems(P('小丙', 'pi'), ctx)
  assert.deepEqual(piItems.filter(i => i.ok).map(i => i.key).sort(), ['close', 'model'], 'pi 可以切換模型與關閉')
  const why = piItems.filter(i => !i.ok).map(i => i.reason)
  assert.ok(why.every(r => /[一-鿿]/.test(r) && r !== REASON.otherEngine), 'pi 其餘項目各有自己的中文原因')
  assert.equal(partnerEngine(P('小丙', 'pi')), 'pi')
  assert.equal(ok(P('ASN-開發', 'grok'), 'close').reason, REASON.cloud)
  assert.equal(ok(P('Gemini', 'gemini', { kind: undefined }), 'close').reason, '')
  assert.match(ok(P('Gemini', 'gemini', { kind: undefined }), 'model').reason, /不能在這裡切換模型/)
})

test('現況：電腦端（partner_ops.rs）——非 Claude 的關閉與切換模型根本找不到對象；ACP 工作者只做四件事（含停止）', () => {
  const rs = fs.readFileSync(new URL('../src-tauri/src/bridge/partner_ops.rs', import.meta.url), 'utf8')
  assert.match(rs, /"close" => self\.close\(&target\)/)
  assert.match(rs, /"model" => self\.model\(op, target\)/)
  assert.match(rs, /找不到這個夥伴的 Claude 視窗/, 'find_target 只認 Claude 的 sessions 檔')
  assert.match(rs, /_ => failed\(UNSUPPORTED\)/, 'ACP 工作者其餘動作回「這類夥伴不支援」')
  const admin = fs.readFileSync(new URL('../src-tauri/src/bridge/engines/acp_admin.rs', import.meta.url), 'utf8')
  assert.match(admin, /只管詳情、重開、接班換手、關閉（停止本次執行，不改設定檔）四件事；改名、切換模型、喚醒不支援/)
})

// ---- 缺口（尚未做；node:test 的 todo：跑得過會顯示、跑不過不算失敗，補完行為後把 todo 拿掉）----
test('ASN 自己跑的 Grok 背景工作者（名單 engine=grok、沒有 kind）跟 Gemini 一樣有「重開」「接班換手」（#234）', () => {
  const worker = P('Grok', 'grok', { kind: undefined })
  assert.equal(partnerEngine(worker), 'acp')
  assert.equal(ok(worker, 'restart').ok, true)
  assert.equal(ok(worker, 'handover').ok, true)
})

test('缺口：Codex 視窗應該能「關閉」', { todo: '電腦端只會找 Claude 的視窗，Codex 沒有對應的關閉路徑' }, () => {
  assert.equal(ok(P('小乙', 'codex'), 'close').ok, true)
})

test('pi 視窗能「關閉」（0.2 A2）；離線的反灰', () => {
  assert.equal(ok(P('小丙', 'pi'), 'close').ok, true)
  assert.equal(ok(P('小丙', 'pi', { status: 'offline' }), 'close').ok, false)
})

test('pi 視窗的切換模型：離線反灰、送出內容把「提供者/模型」寫成後台收得下的格式、輸入檢查', () => {
  const pi = P('小丙', 'pi')
  assert.equal(ok(P('小丙', 'pi', { status: 'offline' }), 'model').ok, false)
  assert.equal(opFormError(pi, 'model', { model: 'anthropic/claude-sonnet-5' }, ok(pi, 'model')), '')
  assert.equal(opFormError(pi, 'model', { model: 'claude-sonnet-5' }, ok(pi, 'model')), '')
  for (const bad of ['', 'a b', 'a/b/c', '/m', 'p/', 'x;calc', '../x']) assert.notEqual(opFormError(pi, 'model', { model: bad }, ok(pi, 'model')), '', bad)
  assert.deepEqual(buildOpRequest(pi, 'model', { model: ' anthropic/claude-sonnet-5 ' }), { node: 'H', name: '小丙', op: 'model', model: 'anthropic[claude-sonnet-5]' })
  assert.equal(buildOpRequest(pi, 'model', { model: 'gpt-6' }).model, 'gpt-6')
  assert.ok(MODEL_RE.test(buildOpRequest(pi, 'model', { model: 'openai-codex/gpt-6.1' }).model), '後台的格式檢查收得下')
  assert.equal(buildOpRequest(P('小甲', 'claude'), 'model', { model: 'opus' }).model, 'opus', 'Claude 不變')
})

test('電腦端接線：model 動作遇到 pi 視窗走 pi_control（只在 desktop 編譯的 bridge 底下）', () => {
  const rs = fs.readFileSync(new URL('../src-tauri/src/bridge/partner_ops.rs', import.meta.url), 'utf8')
  assert.match(rs, /if self\.is_pi_window\(&op\.name\) \{\s*return self\.execute_pi\(op\);/)
  assert.match(rs, /pi_control::set_model\(/)
})

test('ACP 背景工作者能「關閉」（停止本次執行），Gemini／agy／本機 Grok 都是（#235 第一階段）；切換模型沒接，維持反灰並說明', () => {
  for (const [a, e] of [['Gemini', 'gemini'], ['Agy', 'agy'], ['Grok', 'grok']]) {
    const w = P(a, e, { kind: undefined })
    assert.equal(ok(w, 'close').ok, true, e)
    assert.equal(ok(w, 'close').label, '關閉')
    assert.equal(ok(w, 'model').ok, false)
    assert.match(ok(w, 'model').reason, /設定檔/)
  }
})
