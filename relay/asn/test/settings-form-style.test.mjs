// 設定表單的統一風格與「更新」頁的排版：
// 1. 勾選框那條規則（label.chk）原本沒生效，是因為權重輸給設定表單的 label 規則——改成「真的掛載元件、把 style.css 放進文件、
//    查實際計算出來的樣式」，不再自己算權重；以後有人把規則改輸掉，計算出來的排法會變，測試會紅。
// 2. 更新頁是一張卡片：勾選框＋文字同一行、下一行「立即檢查」＋狀態、再下面是更新記錄（用 DOM 順序查，不切字串）。
// （#1763 T5：原本讀 style.css 做正規表示式＋自算權重、再把 SSR 輸出的字串切開。尺寸、溢出等 node 算不出來的由 smoke 探針負責。）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { formatCheckTime, updateStatus } from '../ui/lib/update.mjs'
import { withIdentity } from './helpers/with-identity.mjs'
import { mountComponent } from './helpers/render.mjs'

const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const state = (over = {}) => ({
  autoCheck: true, version: '0.1.13', log: [],
  upd: { checking: false, installing: false, manual: '', status: updateStatus({ lastCheck: 0, current: '0.1.13' }) },
  accounts: { list: [], current: null, codexLine: '', busy: false, confirmDel: '', msg: '', trustOwn: false, remote: { node: '', devices: [], list: [], loading: false, busy: false, msg: '' } },
  ...over,
})

// 掛載設定表單，並把真的 style.css 放進同一份文件（happy-dom 不排版，但會依選擇器、權重、順序算出 getComputedStyle）
const mountWithCss = (catKey, st = state(), extra = {}) => {
  const m = mountComponent(SettingsPanel, { st, catKey, ...extra })
  const style = m.document.createElement('style')
  style.textContent = css
  m.document.head.appendChild(style)
  const cs = (el) => m.window.getComputedStyle(el)
  const unmount = () => { style.remove(); m.unmount() }
  return { ...m, cs, unmount }
}
const withMount = async (catKey, st, fn, extra) => {
  const m = mountWithCss(catKey, st, extra)
  try { return await fn(m) } finally { m.unmount() }
}

// 在設定表單根（.list.settings）裡放一個測試用元素，查它實際算出來的樣式
const probe = (m, html) => {
  const host = m.find('.settings')
  const wrap = m.document.createElement('div')
  wrap.innerHTML = html
  const el = wrap.firstElementChild
  host.appendChild(el)
  return el
}

test('計算樣式的探測方法本身：同一個設定表單裡，一般 label 是直排、label.chk 是橫排——兩條規則真的在互相競爭', async () => {
  await withMount('update', state(), (m) => {
    const plain = probe(m, '<label><span>名稱</span><input type="text"></label>')
    assert.equal(m.cs(plain).flexDirection, 'column', '一般 label 照設定表單規則直排')
    const chk = m.find('label.chk')
    assert.ok(chk, '更新頁有 label.chk')
    assert.equal(m.cs(chk).flexDirection, 'row', 'label.chk 贏過直排規則')
    // 探測方法有效：拿掉 chk 這個 class，同一個 label 就掉回直排
    chk.classList.remove('chk')
    assert.equal(m.cs(chk).flexDirection, 'column', '沒有 chk class 時回到直排（證明排法來自 label.chk 規則）')
  })
})

test('勾選框那行（label.chk）的排版，實際計算出來要贏過設定表單的直排 label 規則', async () => {
  await withMount('update', state(), (m) => {
    const chk = m.find('label.chk')
    const s = m.cs(chk)
    assert.equal(s.display, 'flex')
    assert.equal(s.flexDirection, 'row', '勾選框與文字同一行')
    assert.equal(s.alignItems, 'center')
    // 所有會把設定 label 排成直的選擇器，都不能讓 chk 變直
    const col = m.cs(probe(m, '<label><span>x</span></label>'))
    assert.equal(col.flexDirection, 'column')
    assert.notEqual(s.flexDirection, col.flexDirection)
  })
})

test('勾選框不被 `.settings input` 的 flex:1／外框撐開：實際算出來是固定 16px、不伸縮、沒有外框', async () => {
  await withMount('update', state(), (m) => {
    const box = m.find('label.chk input[type=checkbox]')
    const s = m.cs(box)
    assert.equal(s.width, '16px')
    assert.equal(s.height, '16px')
    assert.equal(s.flexGrow, '0', '勾選框不 flex:1')
    assert.ok(['0', '0px'].includes(s.borderTopWidth), `沒有外框，實際是「${s.borderTopWidth}」（空字串＝樣式根本沒算出來，不算過關）`)
    // 對照：一般文字輸入框會 flex:1（通用規則真的有生效，所以勾選框的重置規則是必要的）
    const text = m.cs(probe(m, '<input type="text">'))
    assert.equal(text.flexGrow, '1', '通用規則讓輸入框 flex:1')
    assert.notEqual(s.flexGrow, text.flexGrow)
  })
})

test('表單元件統一：下拉、文字輸入、多行輸入同一套外框', async () => {
  await withMount('look', undefined, (m) => {
    const els = [probe(m, '<select><option>a</option></select>'), probe(m, '<input type="text">'), probe(m, '<textarea></textarea>')]
    const want = m.cs(els[0])
    // --line 的實際色：拿一個直接寫 border:1px solid var(--line) 的對照元素算出來（不寫死色碼，換主題也不用改測試）
    const line = m.cs(probe(m, '<div style="border:1px solid var(--line)"></div>')).borderTopColor
    assert.notEqual(line, '', '對照元素的 var(--line) 有解出顏色')
    for (const el of els) {
      const s = m.cs(el)
      assert.equal(s.borderTopWidth, '1px', `${el.tagName} 外框 1px`)
      assert.equal(s.borderTopStyle, 'solid', `${el.tagName} 實線外框`)
      assert.equal(s.borderTopLeftRadius, '4px', `${el.tagName} 圓角 4px`)
      assert.equal(s.borderTopLeftRadius, want.borderTopLeftRadius)
      // border:1px solid var(--line) 要真的解出一個顏色，不是空字串（空字串＝變數沒解開或樣式沒套到）
      assert.notEqual(s.borderTopColor, '', `${el.tagName} 外框顏色不能是空字串`)
      assert.equal(s.borderTopColor, line, `${el.tagName} 外框顏色要解成 --line 的值（實際「${s.borderTopColor}」）`)
      assert.equal(s.borderTopColor, want.borderTopColor, `${el.tagName} 外框顏色一致`)
    }
    // 勾選框、選項鈕不套這組外框（由 :not() 排除）
    assert.notEqual(m.cs(probe(m, '<input type="checkbox">')).borderTopLeftRadius, '4px')
  }, {})
})

// ---------- 更新頁的版面 ----------
// a 在 b 前面（文件順序）
const before = (a, b) => Boolean(a.compareDocumentPosition(b) & 4)   // DOCUMENT_POSITION_FOLLOWING

test('更新頁：一張卡片——勾選框與文字同一個 label、下一行立即檢查＋狀態、最後才是更新記錄', async () => {
  await withMount('update', state(), (m) => {
    const card = m.find('section.set-card.upd-card')
    assert.ok(card, '更新頁是一張 set-card upd-card')
    const label = m.find('label.chk', card)
    assert.ok(label, '勾選框在卡片裡')
    const box = m.find('input[type=checkbox]', label)
    const text = m.find('span', label)
    assert.ok(box && text && text.textContent === '自動檢查更新', '勾選框在左、文字在右，同一個 label')
    assert.ok(before(box, text))
    const row = m.find('.upd-row', card)
    const btn = m.findByText('立即檢查', 'button', row)
    const status = m.find('.upd-status', row)
    assert.ok(row && btn && status, '按鈕與狀態在同一行容器裡，且都在卡片裡面')
    assert.ok(before(label, btn) && before(btn, status), '勾選框 → 立即檢查 → 狀態')
    // 含這段字的最內層元素（findByText 的 '*' 會先抓到最外層）
    const logTitle = m.findAll('*').filter((x) => x.textContent.includes('版本更新記錄')).at(-1)
    assert.ok(logTitle, '有版本更新記錄')
    assert.ok(!card.contains(logTitle), '更新記錄不在卡片裡')
    assert.ok(before(status, logTitle), '更新記錄在最後')
    // 實際排法：卡片直排、勾選框那行橫排、按鈕＋狀態那行橫排
    assert.equal(m.cs(card).flexDirection, 'column')
    assert.equal(m.cs(label).flexDirection, 'row')
    assert.equal(m.cs(row).display, 'flex')
    assert.notEqual(m.cs(row).flexDirection, 'column', '按鈕與狀態同一行（不直排）')
  })
})

test('更新頁狀態文字：目前版本、最後檢查時間、已是最新／有新版／檢查中／失敗', () => {
  const now = new Date(2026, 9, 21, 15, 0).getTime()
  const at = new Date(2026, 9, 21, 14, 3).getTime()
  const base = { current: '0.1.13', lastCheck: at }
  assert.deepEqual(updateStatus(base, now), { tone: 'ok', head: '已是最新版', lines: ['目前版本 0.1.13', '最後檢查：今天 14:03'] })
  assert.equal(updateStatus({ current: '0.1.13' }, now).tone, 'idle')
  assert.deepEqual(updateStatus({ current: '0.1.13' }, now).lines, ['目前版本 0.1.13', '尚未檢查過'])
  const nw = updateStatus({ ...base, phase: 'available', info: { version: '0.1.14' } }, now)
  assert.equal(nw.tone, 'new'); assert.match(nw.head, /0\.1\.14/)
  assert.equal(updateStatus({ ...base, checking: true }, now).head, '檢查中…')
  assert.equal(updateStatus({ ...base, installing: true }, now).tone, 'busy')
  const er = updateStatus({ ...base, error: '連不上' }, now)
  assert.equal(er.tone, 'err'); assert.match(er.head, /連不上/)
  assert.equal(formatCheckTime(new Date(2026, 9, 19, 9, 5).getTime(), now), '10/19 09:05')
  assert.equal(formatCheckTime(0, now), '')
  assert.equal(formatCheckTime(NaN, now), '')
})

test('其他有勾選框的設定（登入時自動啟動、信任自己的設備）也用同一種排法', async () => {
  await withMount('update', state(), (m) => {
    assert.equal(m.findAll('label.chk').length, 1)
  })
  await withMount('window', { ...state(), autostart: { supported: true, on: false, busy: false }, closeTo: 'tray', trayOk: true }, (m) => {
    const l = m.findAll('label.chk').find((x) => x.textContent.trim() === '登入時自動啟動 ASN')
    assert.ok(l, '登入時自動啟動是 label.chk（checkbox 在左、文字在右）')
    assert.ok(l.firstElementChild.matches('input[type=checkbox]') && l.lastElementChild.matches('span'))
    assert.equal(m.cs(l).flexDirection, 'row')
  })
  const dev = state({ devices: [{ key: 'H', label: '家用機', self: true, kind: '電腦', online: true, onlineText: '在線', reportedText: '', empty: '', vendors: [] }].map(withIdentity) })
  await withMount('devices', dev, (m) => {
    const l = m.findAll('label.chk').find((x) => x.textContent.includes('允許別台設備替這台切換帳號'))
    assert.ok(l, '允許別台設備替這台切換帳號是 label.chk')
    assert.ok(l.firstElementChild.matches('input[type=checkbox]') && l.lastElementChild.matches('span'))
    assert.equal(m.cs(l).flexDirection, 'row')
  }, { dev: 'H' })
})
