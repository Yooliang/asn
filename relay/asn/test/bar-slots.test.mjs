// #539 對話上方固定 6 格：barSlots 的順序、反灰與原因（20 字內）。右鍵選單也用同一個函式（list.js）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { BAR_KEYS, TASKS_WHY, WHY_MAX, barSlots, briefWhy, modelViaPartnerOp } from '../ui/lib/actionbar.mjs'
import { REASON } from '../ui/lib/partner-ops.mjs'
import { canOfferSubagents } from '../ui/lib/subagents.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const F = (o = {}) => ({ id: 'H/a', node: 'H', agent: 'a', nick: 'a', status: 'idle', engine: 'claude', ...o })
const ops = { loaded: true, signedIn: true, machines: { H: { online: true, launcher: { profiles: [] } } } }
const CTX = { selfNode: 'H', api: true, callable: true, console: { state: 'toggle', visible: true }, subagents: true, ops, manageCount: 5 }
const view = (f, ctx = CTX) => Object.fromEntries(barSlots(f, ctx).map(s => [s.key, s]))
const oks = (f, ctx = CTX) => barSlots(f, ctx).map(s => s.ok)

test('固定 6 格、順序不變；任何夥伴都 6 格；反灰一定有原因、能用一定沒有；原因 20 字內', () => {
  const kinds = [F(), F({ status: 'offline' }), F({ engine: 'gemini' }), F({ engine: 'grok' }), F({ engine: 'pi' }), F({ receivable: false }), F({ entryKind: 'process', engine: 'pi' }), F({ pending: true }), F({ node: 'W' }), F({ engine: 'codex' }), null]
  for (const f of kinds) {
    for (const ctx of [CTX, {}, { ...CTX, console: { state: 'checking' } }, { ...CTX, ops: { signedIn: false } }]) {
      const s = barSlots(f, ctx)
      assert.deepEqual(s.map(x => x.key), BAR_KEYS, JSON.stringify(f))
      for (const x of s) {
        assert.equal(Boolean(x.reason), !x.ok, `${x.key} ${JSON.stringify(f)}`)
        assert.ok(x.reason.length <= WHY_MAX, `${x.key}：${x.reason}`)
        assert.ok(!/[A-Za-z]{4,}/.test(x.reason.replace(/Claude/g, '')), `純中文（產品名除外）：${x.reason}`)
      }
    }
  }
  assert.deepEqual(BAR_KEYS, ['call', 'window', 'model', 'subs', 'tasks', 'manage'])
})

test('閒置的本機 Claude：除了工作項目（下一版開放）全部可按；第 2 格依視窗狀態寫後台隱藏／前台顯示', () => {
  assert.deepEqual(oks(F()), [true, true, true, true, false, true])
  assert.equal(view(F()).tasks.reason, TASKS_WHY)
  assert.equal(view(F()).window.label, '後台隱藏')
  assert.equal(view(F(), { ...CTX, console: { state: 'toggle', visible: false } }).window.label, '前台顯示')
  const checking = view(F(), { ...CTX, console: { state: 'checking' } }).window
  assert.deepEqual([checking.ok, checking.label, checking.reason], [false, '前台／後台', '檢查中…'])
  assert.equal(view(F(), { ...CTX, console: { state: 'none', reason: '' } }).window.reason, '找不到這個夥伴的視窗')
  assert.equal(view(F(), { ...CTX, manageCount: 0 }).manage.ok, false, '管理選單沒有項目就反灰')
  assert.equal(view(F(), { ...CTX, callable: false }).call.reason, '這個畫面沒有語音功能')
})

test('離線的 Claude：通話、前台／後台、切換模型、子代理都反灰並說要先喚醒；管理可按（喚醒在裡面）', () => {
  const v = view(F({ status: 'offline' }))
  assert.deepEqual(oks(F({ status: 'offline' })), [false, false, false, false, false, true])
  assert.equal(v.call.reason, '夥伴離線，不能通話')
  for (const k of ['window', 'model', 'subs']) assert.equal(v[k].reason, '夥伴離線，要先喚醒', k)
})

test('ACP 工作者（名單上 engine 是 gemini／grok）：第 2 格「ACP 模式」反灰；切換模型可按（照右鍵 menuItems）；子代理不適用', () => {
  for (const engine of ['gemini', 'grok', 'agy']) {
    const f = F({ engine })
    const v = view(f)
    assert.deepEqual([v.window.label, v.window.ok, v.window.reason], ['ACP 模式', false, '內建通道執行，沒有視窗'], engine)
    assert.equal(v.model.ok, true, `${engine}：對話頁和右鍵一樣可以換模型`)
    assert.equal(v.subs.ok, false)
    assert.equal(modelViaPartnerOp(f), true, '走夥伴管理對話框（手動輸入代號）')
  }
  assert.equal(view(F({ engine: 'gemini', status: 'offline' })).model.reason, '工作者已離線')
  assert.equal(view(F({ engine: 'gemini' }), { ...CTX, ops: { signedIn: false } }).model.ok, false, '沒登入就跟右鍵一樣反灰')
  assert.equal(view(F({ engine: 'grok', kind: 'grok', node: 'G' })).window.label, '前台／後台', '雲端代理不是 ACP')
})

test('pi 視窗：切換模型可按（向 pi 查清單）、子代理不適用；別台電腦的 pi 照右鍵規則', () => {
  const v = view(F({ engine: 'pi' }))
  assert.equal(v.model.ok, true)
  assert.equal(modelViaPartnerOp(F({ engine: 'pi' })), true)
  assert.equal(v.subs.reason, '只有 Claude 有子代理')
  assert.equal(v.window.label, '後台隱藏', 'pi 有視窗，照前台／後台')
  assert.equal(modelViaPartnerOp(F()), false, 'Claude 用型號選單')
})

test('唯讀（自己開的程式、不能收信）與等待中（視窗開啟中）', () => {
  const ro = view(F({ receivable: false }))
  assert.deepEqual([ro.call.ok, ro.call.reason], [false, '只能顯示，不能通話'])
  assert.deepEqual([ro.model.ok, ro.subs.ok], [false, false])
  const proc = view(F({ entryKind: 'process', engine: 'pi', agent: 'pi #3（前景）' }))
  assert.equal(proc.model.reason, '自己開的程式，只能顯示')
  const p = view(F({ pending: true }))
  assert.deepEqual(oks(F({ pending: true })), [false, false, false, false, false, true])
  for (const k of ['call', 'window', 'model', 'subs']) assert.equal(p[k].reason, '視窗還在開啟中', k)
})

test('別台電腦、沒有 transport、沒選到夥伴', () => {
  const w = view(F({ node: 'W' }))
  for (const k of ['window', 'subs']) assert.equal(w[k].reason, '視窗在另一台電腦上', k)
  assert.equal(w.model.reason, '視窗在另一台電腦上')
  const noApi = view(F(), { ...CTX, api: false })
  assert.equal(noApi.window.reason, '這個畫面不能切換視窗')
  assert.equal(noApi.model.reason, '這個畫面不能切換模型')
  assert.ok(barSlots(null).every(s => !s.ok && s.reason === '沒有選到夥伴'))
})

test('子代理那一格與 canOfferSubagents 一致；切換模型帶查詢結果時照查詢', () => {
  for (const f of [F(), F({ node: 'W' }), F({ engine: 'gemini' }), F({ engine: 'codex' }), F({ pending: true })]) {
    assert.equal(view(f).subs.ok, canOfferSubagents(f, { selfNode: 'H', engine: f.engine }), JSON.stringify(f))
  }
  assert.equal(view(F(), { ...CTX, modelQuery: { state: 'checking', items: [] } }).model.reason, '檢查中…')
  assert.equal(view(F(), { ...CTX, modelQuery: { state: 'ready', items: [{ id: 'x' }] } }).model.ok, true)
  assert.equal(view(F(), { ...CTX, modelQuery: { state: 'ready', items: [] } }).model.reason, '查不到可切換的模型')
})

test('長原因縮成 20 字內：認得的換短說法，其餘截斷', () => {
  assert.equal(briefWhy(REASON.closed), '這台電腦沒開放遠端管理')
  assert.equal(briefWhy('短的'), '短的')
  const cut = briefWhy('一'.repeat(30))
  assert.equal(cut.length, WHY_MAX)
  assert.ok(cut.endsWith('…'))
  for (const r of Object.values(REASON)) assert.ok(briefWhy(r).length <= WHY_MAX, r)
})

test('接線：名單右鍵用 barSlots 的第 2、3 格與 partnerMenuItems；ACP／pi 的切換模型開夥伴管理對話框', () => {
  const js = read('ui/list.js'), html = read('ui/list.html'), bar = read('ui/lib/actionbar.mjs')
  assert.match(js, /const s = barSlots\(c, \{ selfNode: info\.node, api: true, console: buddyConsole, ops: buddyOpsCtx\.value, modelQuery: buddyModel\.show \? buddyModel : null \}\)/)
  assert.match(js, /if \(it\.key === 'adopt'\) \{ void adoptLoad\(\); return \}/)
  assert.match(html, /@click="openPartnerOp\(buddyModelItem\)"/)
  assert.match(bar, /if \(modelViaPartnerOp\(props\.friend\)\) \{[^\n]*Object\.assign\(opDlg, \{ open: true, item: \{ key: 'model'/)
  assert.match(bar, /:pi-models="piModels"/)
  assert.doesNotMatch(bar + js + read('ui/lib/model-switch.mjs') + read('ui/lib/subagents.mjs'), /friend\.engine === 'acp'|c\.engine === 'acp'/, 'ACP 一律看 partnerEngine')
})
