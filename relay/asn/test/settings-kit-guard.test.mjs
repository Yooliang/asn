// 設定頁搬進共用按鈕（#2105）的守門：舊按鈕不得回來、不寫死字級與間距、確認一律取消在左確定在右、危險動作是危險鈕。
// 規範：docs/畫面規範.md 第二節（按鈕）、4-1（確認一律原位）、第八節（設備列）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { withIdentity } from './helpers/with-identity.mjs'
import { mountComponent } from './helpers/render.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const settle = async m => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); await m.nextTick() } }
const panel = read('../ui/lib/settings-panel.mjs')
const css = read('../ui/style.css')

// ---------- 原始碼 ----------
test('#2105 設定頁：舊按鈕（aero-btn）與裸 <button> 都不得再出現，全部走共用按鈕', () => {
  assert.doesNotMatch(panel, /aero-btn/, '設定頁的按鈕不能再用舊 class')
  assert.doesNotMatch(panel, /<button[\s>]/, '設定頁不再自己寫 <button>，一律 <asn-button>')
  assert.ok((panel.match(/<asn-button[\s>]/g) ?? []).length >= 70, '原本約 75 顆按鈕都換成共用按鈕')
})

test('#2105 設定頁：樣板不寫死字級與間距（px），尺寸只來自共用按鈕與設計變數', () => {
  assert.doesNotMatch(panel, /(?:font-size|padding|margin|gap|min-height|line-height)\s*:[^;"'`]*\d+px/, '不寫死字級與間距')
  assert.doesNotMatch(panel, /style="[^"]*\d+px/, '不用行內樣式寫 px')
  assert.doesNotMatch(panel, /<asn-button[^>]*\sstyle=/, '按鈕不接行內樣式')
})

test('#2105 設定頁專屬的按鈕尺寸覆寫都刪掉了：樣式表不再替設定頁的按鈕改尺寸／內距／字級', () => {
  for (const sel of ['.launch-set .aero-btn', '.launch-set .sec-head .aero-btn', '.dv-vb .aero-btn', '.dv-tabs .aero-btn', '.launch-cwd-list .aero-btn', '.tm-table .aero-btn', '.dv-devbtn']) {
    assert.ok(!css.includes(sel), `樣式表不該再有「${sel}」`)
  }
  // 留下的（排版用）規則只准動位置，不准動尺寸、內距、字級
  const kept = ['.launch-set .sec-head>.asn-btn', '.launch-set .set-card>.asn-btn', '.launch-cwd-list .asn-btn', '.dv-tabs .asn-btn']
  for (const sel of kept) {
    const esc = sel.replace(/[.>[\]]/g, '\\$&')
    const rules = [...css.matchAll(new RegExp(`${esc}\\{[^}]*\\}`, 'g'))].map(m => m[0])
    assert.ok(rules.length > 0, `應該留著排版規則：${sel}`)
    for (const r of rules) {
      const body = r.slice(r.indexOf('{'))
      assert.doesNotMatch(body, /font-size|padding|min-height|(?:^|[;{])height|(?:^|[;{])width|line-height/, `${sel} 只准排版，不准改尺寸：${r}`)
      assert.doesNotMatch(body, /(?:margin|gap)[a-z-]*:[^;}]*\d+px/, `${sel} 的間距不寫死 px：${r}`)
    }
  }
})

test('#2105 設備列的切換鈕（第八節）：固定尺寸 fixed、狀態用 current／busy／blocked，一般可切換不加狀態', () => {
  const tag = panel.slice(panel.indexOf('<asn-button fixed'), panel.indexOf('>', panel.indexOf('<asn-button fixed') + 40))
  assert.match(tag, /class="dv-devbtn"/)
  assert.match(tag, /:state="b\.state === 'switch' \? '' : b\.state"/)
  assert.match(tag, /:disabled="b\.state !== 'switch' \|\| busyNow"/, '可不可以按的條件沒有改')
})

// ---------- 實際掛載 ----------
const vend = (key, label, accounts) => ({ key, label, account: '', reported: accounts.length > 0, extra: '', accounts, switchable: false, switchHint: '' })
const dev = (key, label, o = {}) => withIdentity({ key, label, self: false, kind: '電腦', online: true, onlineText: '在線', hidden: false, removed: false, reportedText: '', empty: '', vendors: [vend('claude', 'Claude', [{ email: `${key}@b.c`, plan: 'pro', current: true }])], ...o })
const ACCT = { list: [], current: null, codexLine: '', busy: false, confirmDel: '', msg: '', trustOwn: false, autoAdd: true, autoNote: '', mod: '', remote: { node: '', devices: [], list: [], loading: false, busy: false, msg: '' } }
const mountDev = (props, devices) => mountComponent(SettingsPanel, { st: { devices, accounts: ACCT }, meAv: '', catKey: 'devices', ...props })
const OFFLINE = () => [dev('H', '家用機', { self: true }), dev('G', '舊電腦', { online: false, onlineText: '離線', hidden: false })]
const texts = btns => btns.map(b => b.textContent.trim())

test('#2105 永久移除：危險鈕（st-danger）；按下後原位確認，取消在左、確定移除在右，且只有右邊是危險鈕', async () => {
  const m = mountDev({ dev: 'G', devView: 'info' }, OFFLINE())
  try {
    await settle(m)
    const rm = m.findAll('button').find(b => b.textContent.trim() === '永久移除')
    assert.ok(rm, '有永久移除鈕')
    assert.ok(rm.className.includes('st-danger'), '永久移除是危險鈕')
    await m.trigger(rm, 'click'); await settle(m)
    const box = m.container.querySelector('.asn-confirm')
    assert.ok(box, '確認出現在原位（共用的確認元件），不跳框')
    const btns = [...box.querySelectorAll('button')]
    assert.deepEqual(texts(btns), ['取消', '確定移除'], '取消在左、確定在右')
    assert.ok(btns[1].className.includes('st-danger') && !btns[0].className.includes('st-danger'), '只有右邊那顆是危險鈕')
    await m.trigger(btns[0], 'click'); await settle(m)
    assert.equal(m.container.querySelector('.asn-confirm'), null, '取消只收起確認')
    assert.ok(!m.emitted('act').some(e => e[0] === 'device-remove'), '取消不呼叫後端')
  } finally { m.unmount() }
})

test('#2105 永久移除：確定才送 device-remove（確認的右邊那顆）', async () => {
  const m = mountDev({ dev: 'G', devView: 'info', askRemove: true }, OFFLINE())
  try {
    await settle(m)
    const btns = [...m.container.querySelectorAll('.asn-confirm button')]
    assert.deepEqual(texts(btns), ['取消', '確定移除'])
    await m.trigger(btns[1], 'click'); await settle(m)
    assert.deepEqual(m.emitted('act').find(e => e[0] === 'device-remove'), ['device-remove', 'G'])
  } finally { m.unmount() }
})

test('#2105 設備列上方那排頁籤：共用按鈕（次要），按下的那顆標 aria-pressed', async () => {
  const m = mountDev({ dev: 'G', devView: 'info' }, OFFLINE())
  try {
    await settle(m)
    const tabs = [...m.container.querySelectorAll('.dv-tabs button')]
    assert.ok(tabs.length >= 1 && tabs.every(b => b.className.includes('asn-btn') && b.className.includes('lv-secondary')))
    assert.equal(tabs.find(b => b.textContent.trim() === '詳情')?.getAttribute('aria-pressed'), 'true')
  } finally { m.unmount() }
})

const mountWindow = bridge => mountComponent(SettingsPanel, {
  st: { trayOk: true, closeTo: 'tray', autostart: { supported: false }, guard: { supported: false }, bridge: { running: false, legacy: true, takeoverAllowed: true, confirm: true, busy: false, termServerSupported: false, termServerMissing: false, keyProtection: '', error: '', ...bridge } },
  meAv: '', catKey: 'window',
})

test('#2105 改由 ASN 負責的確認：取消在左、確定在右；各自送自己的指令', async () => {
  const m = mountWindow({})
  try {
    await settle(m)
    const btns = [...m.container.querySelectorAll('.asn-confirm button')]
    assert.deepEqual(texts(btns), ['取消', '確定'], '取消在左、確定在右')
    assert.ok(btns[1].className.includes('lv-primary'))
    await m.trigger(btns[0], 'click'); await m.trigger(btns[1], 'click')
    assert.deepEqual(m.emitted('act').map(e => e[0]), ['bridge-takeover-no', 'bridge-takeover-yes'])
  } finally { m.unmount() }
})

test('#2105 改由 ASN 負責的確認：處理中兩顆都不能按（原本的 disabled 條件沒有變）', async () => {
  const m = mountWindow({ busy: true })
  try {
    await settle(m)
    assert.ok([...m.container.querySelectorAll('.asn-confirm button')].every(b => b.disabled))
  } finally { m.unmount() }
})

test('#2105 移除／刪除／結束／忘記／撤銷這類不可復原的動作，按鈕都是危險狀態', () => {
  const must = ['tm-ask', 'acct-remove', 'quota-mm-remove', 'quota-unshare', 'pi-setup-remove', 'forget.ask(p)', 'forget.ask(curKnown)', 'askRemove = true', 'tm-confirm', 'forget.yes']
  for (const h of must) {
    const tag = [...panel.matchAll(/<asn-button\b[^>]*>/g)].map(m => m[0]).find(t => t.includes(h))
    assert.ok(tag, `找得到按鈕：${h}`)
    assert.match(tag, /state="danger"/, `${h} 要是危險鈕：${tag}`)
  }
  // 反向：取消、一般動作不是危險鈕
  for (const h of ["act('tm-cancel')", "act('relogin-no')", "act('install-no')", 'renameCancel']) {
    const tag = [...panel.matchAll(/<asn-button\b[^>]*>/g)].map(m => m[0]).find(t => t.includes(h))
    assert.ok(tag && !/state="danger"/.test(tag), `${h} 不是危險鈕`)
  }
})
