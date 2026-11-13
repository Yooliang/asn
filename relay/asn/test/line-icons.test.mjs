// 線條圖示（0.2.21，#1461）：一份共用來源（ui/lib/line-icons.mjs），電腦與手機都讀；只給現代外觀，復古 Aero 一律不顯示。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ALIAS, ICONS, MENU_ICON, TAB_ICON, hasIcon, iconShapes, isDangerItem, itemIcon, tabIcon } from '../ui/lib/line-icons.mjs'
import { ADOPT_LABEL, MENU_KEYS, OP_LABEL, SELF_PULL_LABEL } from '../ui/lib/partner-ops.mjs'
import { MORE_OWN_KEYS, WINDOW_LABEL, chatGroupItems } from '../ui/lib/actionbar.mjs'
import { SETTING_CATS } from '../ui/lib/settings-cats.mjs'
import { TABS } from '../ui/lib/mobile.mjs'
import { M_TERM_TOGGLE } from '../ui/lib/term-entry.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('圖示本體：只有 path、circle、rect，屬性是 24×24 的數字或路徑；不帶任何樣式或事件屬性', () => {
  const allowed = { path: ['d'], circle: ['cx', 'cy', 'r'], rect: ['x', 'y', 'width', 'height', 'rx'] }
  assert.ok(Object.keys(ICONS).length >= 40)
  for (const [k, shapes] of Object.entries(ICONS)) {
    assert.ok(shapes.length > 0, k)
    for (const [tag, attrs] of shapes) {
      assert.ok(allowed[tag], `${k}：${tag}`)
      for (const [a, v] of Object.entries(attrs)) {
        assert.ok(allowed[tag].includes(a), `${k}：${tag} 的 ${a}`)
        assert.match(v, a === 'd' ? /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/ : /^-?\d+(\.\d+)?$/, `${k}：${a}`)
      }
    }
  }
})

test('別名與「更多」的三個點：同一個圖不畫兩份；不認得的 key 不畫、不報錯', () => {
  for (const [a, k] of Object.entries(ALIAS)) assert.deepEqual(iconShapes(a), ICONS[k], a)
  const dots = iconShapes('more')
  assert.equal(dots.length, 3)
  assert.ok(dots.every(([tag, at]) => tag === 'circle' && at.fill === 'currentColor'), '唯一用填色的圖示')
  for (const k of ['', 'nope', undefined, null, '__proto__', 'constructor']) assert.deepEqual(iconShapes(k), [], String(k))
  assert.equal(hasIcon('nope'), false)
})

test('選單：夥伴管理的每一項、群組三項、電腦獨有的幾項都有圖示，而且查得到圖；電腦「更多」和手機「⋯」查同一份', () => {
  const keys = [...MENU_KEYS, 'archive', 'unarchive', 'adopt', ...MORE_OWN_KEYS.map(k => k.replace(/^p:/, '')), ...chatGroupItems({ room: true }).map(i => i.key)]
  for (const k of keys) {
    const ic = itemIcon({ key: k, label: '' })
    assert.ok(ic && hasIcon(ic), `${k} → ${ic}`)
    assert.equal(itemIcon({ key: `p:${k}`, label: '' }), ic, `p:${k} 和 ${k} 同一個圖`)
  }
  for (const v of Object.values(MENU_ICON)) assert.ok(hasIcon(v), v)
  // 前台／後台看字；換班接手遇到可接手的終端時字會換成「接手」或「接進收發室」
  assert.equal(itemIcon({ key: 'window', label: WINDOW_LABEL.hide }), 'win_dn')
  assert.equal(itemIcon({ key: 'window', label: WINDOW_LABEL.show }), 'win_up')
  // 和文字常數比對，不看字頭：選單字尾可能多一個「…」
  for (const l of [ADOPT_LABEL, `${ADOPT_LABEL}…`, SELF_PULL_LABEL, `${SELF_PULL_LABEL}…`]) assert.equal(itemIcon({ key: 'p:handover', label: l }), 'adopt', l)
  for (const l of [OP_LABEL.handover, `${OP_LABEL.handover}…`, '接續別的東西']) assert.equal(itemIcon({ key: 'p:handover', label: l }), 'handover', l)
  assert.equal(itemIcon({ key: 'window', label: `${WINDOW_LABEL.hide}…` }), 'win_dn')
  assert.equal(itemIcon({ key: 'window', label: WINDOW_LABEL.idle }), 'win_up', '「前台／後台」這種中性字不算收到後台')
  assert.equal(itemIcon({ key: 'resume', label: '喚醒' }), 'wake')
  assert.equal(itemIcon({ key: 'manage', label: '成員與設定' }), 'members')
  assert.equal(itemIcon({ key: 'nope' }), '')
  assert.equal(itemIcon(null), '')
  // 移除是危險動作（紅色）
  assert.equal(isDangerItem({ key: 'p:remove' }), true)
  assert.equal(isDangerItem({ key: 'remove' }), true)
  assert.equal(isDangerItem({ key: 'close' }), false)
})

test('電腦「更多」與手機「⋯」的範本都用 itemIcon 畫圖示（同一個 key 對到同一個圖）', () => {
  const ab = read('ui/lib/actionbar.mjs')
  const more = ab.slice(ab.indexOf("name: 'MoreMenuButton'"), ab.indexOf("export const ActionBar"))
  assert.match(more, /<line-icon class="mi-ic"[^>]*:name="iconOf\(it\)"/)
  assert.match(more, /iconOf: itemIcon/)
  const ops = ab.slice(ab.indexOf("name: 'OpsMenuButton'"), ab.indexOf("name: 'MoreMenuButton'"))
  assert.doesNotMatch(ops, /line-icon/, '復古 Aero 的「管理」選單不動')
  const m = read('ui/m.html')
  assert.match(m, /@click="pickOp\(i\.key\)"><line-icon class="mi-ic"[^>]*:name="itemIcon\(i\)"/)
  assert.match(m, /@click="pickGroup\(g\.key\)"><line-icon class="mi-ic" :name="itemIcon\(g\)"/)
})

test('設定列表每一類、使用指引、手機四大分頁、終端與訊息切換都有圖示', () => {
  for (const c of SETTING_CATS) assert.ok(hasIcon(c.key), c.key)
  assert.ok(hasIcon('guide'))
  assert.deepEqual(TABS.map(tabIcon), ['partners', 'chats', 'settings', 'notice'])
  for (const t of TABS) assert.ok(hasIcon(TAB_ICON[t]), t)
  assert.equal(tabIcon('page'), '', '第四格暫放內頁時沒有圖示')
  assert.equal(M_TERM_TOGGLE.toTerm.line, 'term')
  assert.equal(M_TERM_TOGGLE.toChat.line, 'msg')
  assert.ok(hasIcon('term') && hasIcon('msg'))
})

test('輸入框工具列：每一顆在原本的彩色圖後面加線條圖示（Aero 的圖原樣保留）', () => {
  const cp = read('ui/lib/chatpane.mjs')
  for (const [label, key] of [['表情符號', 'emoji'], ['傳送震動', 'nudge'], ['傳照片', 'photo'], ['傳送檔案', 'file'], ['截圖', 'shot']]) {
    const i = cp.indexOf(`aria-label="${label}"`)
    const seg = cp.slice(i, cp.indexOf('</button>', i))
    assert.match(seg, /<svg [^]*?<\/svg>\s*<line-icon name="/, label)
    assert.ok(seg.includes(`<line-icon name="${key}">`), label)
  }
  for (const key of ['call', 'dict', 'mic']) assert.ok(cp.includes(`<line-icon name="${key}"></line-icon>`), key)
})

test('復古 Aero 零差異：style.css 把 .lic 一律藏起來；新的現代規則都限定在 :root[data-skin="modern"]', () => {
  assert.match(read('ui/style.css'), /\n\.lic\{display:none\}\n/)
  const css = read('ui/modern.css')
  const part = css.slice(css.lastIndexOf('/*', css.indexOf('#1461 線條圖示'))).replace(/\/\*[\s\S]*?\*\//g, '')
  const sels = [...part.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap(m => m[1].split(',')).map(s => s.trim()).filter(Boolean)
  assert.ok(sels.length > 10)
  for (const s of sels) assert.ok(s.startsWith(':root[data-skin="modern"] '), s)
  assert.match(part, /:root\[data-skin="modern"\] \.lic\{display:inline-block/)
})

test('每個用到 <line-icon> 的頁面都有註冊元件', () => {
  for (const [page, js] of [['list.html', 'list.js'], ['m.html', 'm.js'], ['chat.html', 'chat.js'], ['panel.html', 'panel.js']]) {
    const src = read(`ui/${js}`)
    assert.match(src, /import \{ LineIcon[^}]*\} from '\.\/lib\/line-icons\.mjs'/, js)
    assert.match(src, /app\.component\('line-icon', LineIcon\)/, js)
    void page
  }
})
