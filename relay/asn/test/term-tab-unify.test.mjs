// #904：ASN 直接開的終端分頁直接在畫面打字（term-view），不再有舊輸入框；接手來的窗格保留舊輸入框；上方掛和夥伴對話同一排功能列。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BAR_KEYS, barSlots } from '../ui/lib/actionbar.mjs'
import { TERM_BAR_WHY, TERM_CLOSE_KEY, closeTermRun, termBarBlocked, termCloseTitle, termFriends, termManageItems } from '../ui/lib/term-chat.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = f => fs.readFileSync(path.join(root, f), 'utf8')
const html = read('ui/list.html')
const pane = html.slice(html.indexOf('<div class="pane term-pane"'), html.indexOf('<!-- 指引、設定的聊天窗'))
const compose = pane.slice(pane.indexOf('<div class="tp-compose"'))

test('終端分頁：自己開的分頁有 term-view，舊輸入框只在接手來的窗格出現', () => {
  assert.ok(pane.includes('<term-view v-if="!termPaneRow.adopted"'), '自己開的分頁直接打字')
  assert.ok(compose.startsWith('<div class="tp-compose" v-if="termPaneRow.adopted"'), '舊輸入框只給接手窗格')
  assert.ok(compose.includes('要送進這個終端的文字') && compose.includes('改用手機確認') && compose.includes('adoptUnlockAsk'), '接手窗格的輸入框、手機確認、解鎖都在')
  assert.equal((pane.match(/要送進這個終端的文字/g) ?? []).length, 1, '整個分頁只有一個舊輸入框')
  assert.ok(!pane.slice(0, pane.indexOf('<div class="tp-compose"')).includes('要送進這個終端的文字'), '輸入框之外沒有第二份')
})

test('終端分頁：自己開的分頁讓 term-view 占滿剩餘高度', () => {
  const css = read('ui/style.css')
  assert.ok(pane.includes(`'term-pane-live': !termPaneRow.adopted`))
  assert.match(css, /\.term-pane-live \.tp-body\{[^}]*overflow:hidden/)
  assert.match(css, /\.term-pane-live \.tp-body \.term-view\{[^}]*flex:1 1 0/)
})

test('終端分頁：上方掛和夥伴對話同一個功能列，自己開的分頁只有「管理」可用，其餘 5 格反灰並有說明', () => {
  assert.ok(pane.includes('<action-bar') && pane.includes(':blocked="termBarBlocked"') && pane.includes(':ops="termBarOps"') && pane.includes('@ops="onTermBarOp"'))
  assert.match(read('ui/list.js'), /app\.component\('action-bar', ActionBar\)/)
  const own = { id: '4', profile: 'agy', title: 'agy #4', folder: 'proj', state: 'idle' }
  const slotsOf = row => {
    const f = termFriends([row], { selfNode: 'H' })[0]
    const items = termManageItems(row).map(i => ({ ...i, ok: true, reason: '' }))
    const blocked = termBarBlocked(row)
    return barSlots(f, { selfNode: 'H', api: true, manageCount: items.length }).map(s => (blocked[s.key] ? { ...s, ok: false, reason: blocked[s.key] } : s))
  }
  const mine = slotsOf(own)
  assert.deepEqual(mine.map(s => s.key), BAR_KEYS, '固定 6 格')
  for (const s of mine) {
    if (s.key === 'manage') { assert.equal(s.ok, true, '自己開的分頁管理可用'); continue }
    assert.equal(s.ok, false, s.key); assert.match(s.reason, /[一-鿿]/, s.key)
  }
  const adopted = slotsOf({ ...own, adopted: true })
  for (const s of adopted) { assert.equal(s.ok, false, s.key); assert.match(s.reason, /[一-鿿]/, s.key) }
  assert.match(adopted.find(s => s.key === 'manage').reason, /解除接手/, '接手窗格的管理說明指向「解除接手」')
  assert.deepEqual(Object.keys(TERM_BAR_WHY).sort(), [...BAR_KEYS].sort())
  assert.match(TERM_BAR_WHY.call, /不支援通話/)
  const bar = read('ui/lib/actionbar.mjs')
  assert.ok(bar.includes('props.blocked?.[s.key]') && bar.includes('lite.value'), '簡版不向後端查詢')
  assert.match(bar, /lite\.value \? props\.ops\.map/, '簡版的管理選單用外面給的項目')
})

test('#910 管理選單：自己開的分頁有「關閉視窗」，接手窗格沒有', () => {
  assert.deepEqual(termManageItems({ id: '4', title: 'agy #4' }).map(i => i.key), [TERM_CLOSE_KEY])
  assert.equal(termManageItems({ id: '4', adopted: true }).length, 0)
  assert.equal(termManageItems(null).length, 0)
})

test('#910 關閉視窗：先確認（取消不呼叫），確認後用正確的編號呼叫 termStop；失敗給使用者看得懂的話', async () => {
  const js = read('ui/list.js'), html2 = read('ui/list.html')
  // 選單只會打開確認框，不會直接呼叫 termStop；真的呼叫只在確認鈕的流程裡
  const open = js.slice(js.indexOf('function onTermBarOp'), js.indexOf('function termCloseCancel'))
  assert.ok(open.includes('open: true') && !open.includes('termStop') && !open.includes('closeTermRun'), '選單只開確認框')
  assert.match(js.slice(js.indexOf('async function termCloseConfirm')), /^async function termCloseConfirm[\s\S]*?closeTermRun\(transport, row\)[\s\S]*?termPoller\?\.tickNow\(\)/, '確認後關閉並刷新清單')
  assert.ok(html2.includes('v-if="termClose.open"') && html2.includes('@click="termCloseCancel"') && html2.includes('@click="termCloseConfirm"'))
  assert.equal(termCloseTitle({ title: 'agy #4' }), '要關閉『agy #4』嗎？')
  const calls = []
  const ok = { termStop: async req => { calls.push(req) } }
  assert.deepEqual(await closeTermRun(ok, { id: '7', title: 'x' }), { ok: true, error: '' })
  assert.deepEqual(calls, [{ id: '7' }])
  const bad = { termStop: async () => { throw new Error('IPC 503 internal') } }
  const info = console.info; console.info = () => {}
  let r; try { r = await closeTermRun(bad, { id: '7' }) } finally { console.info = info }
  assert.equal(r.ok, false); assert.ok(!r.error.includes('503') && /[一-鿿]/.test(r.error), '畫面不放技術細節')
})

test('#910 接手窗格不會被這條路關掉', async () => {
  const calls = []
  const r = await closeTermRun({ termStop: async q => { calls.push(q) } }, { id: '9', adopted: true })
  assert.equal(r.ok, false); assert.equal(calls.length, 0)
  const js = read('ui/list.js')
  const fn = js.slice(js.indexOf('function onTermBarOp'), js.indexOf('function termCloseCancel'))
  assert.ok(fn.includes('termPaneRow.value.adopted) return'), '接手窗格連確認框都不開')
})
