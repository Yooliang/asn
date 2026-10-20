// 大頭貼：自動產生（決定性、左右對稱、三種顏色、不同人不同圖）、顯示規則、上傳前的格式與大小檢查、
// AsnCore 對假 relay 的大頭貼同步與上傳。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AVATAR_MAX_BYTES, AVATAR_MAX_CHARS, GRID, avatarFor, avatarSrc, blockieDataUrl, blockieGrid, blockieSvg, checkAvatarDataUrl, friendlyAvatarError, selfAvatarFor, selfAvatarSrc, squareCrop } from '../ui/lib/avatar.mjs'
import { AsnCore } from '../ui/lib/core.mjs'
import { buildFriends, mergeFriends } from '../ui/lib/roster.mjs'
import { startFakeRelay } from './fake-relay.mjs'
import { httpTransport, memStore } from './helpers.mjs'
import { demoUploadUrl, pngDataUrl } from './png.mjs'

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')

// ---------- 自動產生 ----------
test('blockies：同一個種子永遠同一張（決定性）', () => {
  assert.deepEqual(blockieGrid('W/W-政策'), blockieGrid('W/W-政策'))
  assert.equal(blockieSvg('H/H-Irori'), blockieSvg('H/H-Irori'))
  assert.equal(blockieDataUrl('H/H-Irori'), blockieDataUrl('H/H-Irori'))
})

test('blockies：8×8、左右對稱、格子只有 0／1／2、三種顏色互不相同', () => {
  for (const seed of ['W/W-政策', 'H/H-島作', 'aegis/小牧', 'G/G-研究', '', 'x']) {
    const { colors, cells } = blockieGrid(seed)
    assert.equal(cells.length, GRID)
    for (const row of cells) {
      assert.equal(row.length, GRID)
      for (let c = 0; c < GRID; c++) { assert.equal(row[c], row[GRID - 1 - c], `${seed} 不對稱`); assert.ok([0, 1, 2].includes(row[c])) }
    }
    assert.equal(colors.length, 3)
    assert.equal(new Set(colors).size, 3, `${seed} 三種顏色要不同`)
    assert.ok(colors.every(c => /^hsl\(\d+ \d+% \d+%\)$/.test(c)))
  }
})

test('blockies：不同 id 不同圖（500 個 id 沒有撞圖）', () => {
  const seen = new Set()
  for (let i = 0; i < 500; i++) seen.add(blockieSvg(`N${i % 7}/視窗-${i}`))
  assert.equal(seen.size, 500)
  assert.notEqual(blockieSvg('W/W-政策'), blockieSvg('W/W-政第'))
})

test('blockies：SVG 資料網址格式正確、內容只有色塊（不含種子文字、沒有腳本）', () => {
  const seed = 'W/<script>alert(1)</script>'
  const u = blockieDataUrl(seed)
  assert.ok(u.startsWith('data:image/svg+xml;charset=utf-8,'))
  const svg = decodeURIComponent(u.slice('data:image/svg+xml;charset=utf-8,'.length))
  assert.ok(svg.startsWith('<svg ') && svg.endsWith('</svg>'))
  assert.ok(!/script|alert|W\//.test(svg))
  assert.ok(/viewBox="0 0 8 8"/.test(svg))
})

test('守門：自動產生用的是自寫的雜湊與亂數，沒有第三方程式', () => {
  const src = fs.readFileSync(path.join(UI, 'lib', 'avatar.mjs'), 'utf8')
  assert.ok(!/^\s*import\s/m.test(src), 'avatar.mjs 不該 import 任何東西')
  assert.ok(src.includes('function fnv1a') && src.includes('function mulberry32'))
})

// ---------- 上傳前處理 ----------
test('置中裁成正方形', () => {
  assert.deepEqual(squareCrop(400, 200), { sx: 100, sy: 0, s: 200 })
  assert.deepEqual(squareCrop(200, 400), { sx: 0, sy: 100, s: 200 })
  assert.deepEqual(squareCrop(96, 96), { sx: 0, sy: 0, s: 96 })
  assert.deepEqual(squareCrop(101, 50), { sx: 25, sy: 0, s: 50 })
})

test('格式與大小檢查：合法的 png 通過；webp 檔頭通過', () => {
  const png = demoUploadUrl()
  const r = checkAvatarDataUrl(png)
  assert.equal(r.ok, true, r.error)
  assert.equal(r.mime, 'png')
  assert.ok(r.bytes < AVATAR_MAX_BYTES, `示範圖 ${r.bytes} 位元組`)
  assert.equal(checkAvatarDataUrl('data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAw').ok, true)
})

test('格式與大小檢查：svg／gif／jpeg／網址／腳本／空值／壞 base64／檔頭冒充都拒絕，且回中文原因', () => {
  const bad = [
    null, undefined, 5, '', 'data:image/png;base64,', 'javascript:alert(1)', 'https://x/a.png',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/',
    'data:image/png;base64,!!!!', 'data:image/png;base64,iVBORw0K=GgoAAAA',
    'data:image/png;base64,/9j/4AAQSkZJRgABAQEASABIAAD/',   // jpeg 檔頭冒充 png
    'data:image/webp;base64,iVBORw0KGgoAAAANSUhEUg==',      // png 檔頭冒充 webp
  ]
  for (const b of bad) { const r = checkAvatarDataUrl(b); assert.equal(r.ok, false, String(b)); assert.match(r.error, /[一-鿿]/) }
})

test('格式與大小檢查：圖檔超過 32 KB、全長超過 48000 字都拒絕；剛好在上限內通過', () => {
  const head = 'iVBORw0KGgoAAAANSUhEUg'
  const mk = bytes => { const chars = Math.ceil(bytes / 3) * 4; return 'data:image/png;base64,' + head + 'A'.repeat(chars - head.length) }
  assert.equal(checkAvatarDataUrl(mk(AVATAR_MAX_BYTES - 2)).ok, true)
  const over = checkAvatarDataUrl(mk(AVATAR_MAX_BYTES + 1))
  assert.equal(over.ok, false)
  assert.match(over.error, /32 KB/)
  assert.equal(checkAvatarDataUrl('data:image/png;base64,' + head + 'A'.repeat(AVATAR_MAX_CHARS)).ok, false)
})

test('上傳失敗訊息轉成白話中文', () => {
  assert.match(friendlyAvatarError('set_avatar HTTP 400 avatar_too_large'), /太大/)
  assert.match(friendlyAvatarError('set_avatar HTTP 400 bad_avatar_format'), /格式/)
  assert.match(friendlyAvatarError('set_avatar HTTP 404'), /還不支援/)
  assert.match(friendlyAvatarError('set_avatar 連線失敗：x'), /連不上/)
  assert.match(friendlyAvatarError('怪怪的'), /上傳沒有成功/)
})

// ---------- 顯示規則 ----------
const UP_W = demoUploadUrl()
const UP_H = pngDataUrl(96, 96, (x, y) => [200, y * 2, x * 2])

test('顯示規則：名單上的 AI 視窗一律自動產生（就算它那台設備有上傳）', () => {
  const f = { id: 'W/W-政策', node: 'W', onRoster: true }
  const a = avatarFor(f, { avatars: { W: UP_W } })
  assert.deepEqual(a, { kind: 'auto', seed: 'W/W-政策' })
  assert.equal(avatarSrc(f, { avatars: { W: UP_W } }), blockieDataUrl('W/W-政策'))
})

test('顯示規則：不在名單上的寄件人用他那台設備上傳的圖；沒有就自動產生', () => {
  const f = { id: 'K/K-ASN', node: 'K', onRoster: false }
  assert.deepEqual(avatarFor(f, { avatars: { K: UP_W } }), { kind: 'upload', src: UP_W })
  assert.deepEqual(avatarFor(f, { avatars: {} }), { kind: 'auto', seed: 'K/K-ASN' })
  assert.deepEqual(avatarFor(f, { avatars: new Map([['K', { data: UP_W, at: 'x' }]]) }), { kind: 'upload', src: UP_W }, 'Map 形式的快取也行')
  assert.deepEqual(avatarFor(f), { kind: 'auto', seed: 'K/K-ASN' })
  assert.deepEqual(avatarFor({ id: 'K/K-ASN', node: 'K' }, { avatars: { K: UP_W } }), { kind: 'upload', src: UP_W }, '沒標 onRoster 的舊存檔當成名單外')
})

test('顯示規則：別人的設備傳來不合格的圖（svg、腳本）不採用，退回自動產生', () => {
  const f = { id: 'K/K-ASN', node: 'K', onRoster: false }
  for (const evil of ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'javascript:alert(1)', 'https://evil/x.png', 'data:image/png;base64,/9j/4AAQ']) {
    assert.deepEqual(avatarFor(f, { avatars: { K: evil } }), { kind: 'auto', seed: 'K/K-ASN' }, evil)
  }
})

test('顯示規則：自己＝本機節點有上傳就用上傳的，沒有就自動產生（種子＝節點/視窗名）', () => {
  assert.deepEqual(selfAvatarFor({ selfNode: 'H', windowName: 'H-ASN', avatars: { H: UP_H, W: UP_W } }), { kind: 'upload', src: UP_H })
  assert.deepEqual(selfAvatarFor({ selfNode: 'H', windowName: 'H-ASN', avatars: { W: UP_W } }), { kind: 'auto', seed: 'H/H-ASN' })
  assert.equal(selfAvatarSrc({ selfNode: 'H', windowName: 'H-ASN', avatars: {} }), blockieDataUrl('H/H-ASN'))
})

test('名單：AI 視窗標 onRoster、來信對不到名單的標非名單；離線的好友記得它原本在不在名單上', () => {
  const live = buildFriends([{ id: 'W', agents: [{ name: 'W-政策', status: 'idle' }] }], { selfNode: 'H', selfName: 'H-ASN' })
  assert.equal(live[0].onRoster, true)
  const merged = mergeFriends([{ id: 'W/W-政策', node: 'W', agent: 'W-政策', nick: 'W-政策', onRoster: true }, { id: 'K/K-ASN', node: 'K', agent: 'K-ASN', nick: 'K-ASN', onRoster: false }], [])
  assert.deepEqual(merged.map(f => [f.id, f.status, f.onRoster]), [['K/K-ASN', 'offline', false], ['W/W-政策', 'offline', true]])
})

// ---------- AsnCore ＋ 假 relay ----------
const NAME = 'T-ASN'
const members = (extra = []) => [
  { id: 'T', agents: [{ name: NAME, status: 'idle' }] },
  { id: 'W', agents: [{ name: 'W-政策', status: 'idle' }] },
  ...extra,
]
async function setup(opts = {}) {
  const relay = await startFakeRelay({ node: 'T', members: members(opts.extra), avatars: opts.avatars })
  const core = new AsnCore({ transport: httpTransport(relay.url, NAME), store: memStore(), selfNode: 'T', windowName: NAME, pollMs: 60_000, rosterMs: 60_000 })
  return { relay, core }
}

test('同步：名單帶更新時間，只在更新時間變了才取圖；不再上傳就清掉', async () => {
  const { relay, core } = await setup({ avatars: { W: UP_W } })
  let changes = 0
  core.on('avatars', () => changes++)
  await core.refreshRoster()
  assert.deepEqual(core.avatarMap(), { W: UP_W })
  assert.equal(relay.reqs.filter(r => r.action === 'avatar').length, 1)
  await core.refreshRoster()
  assert.equal(relay.reqs.filter(r => r.action === 'avatar').length, 1, '更新時間沒變就不重抓')
  relay.avatars.W = { data: UP_H, at: '2026-10-21T00:00:00Z' }
  await core.refreshRoster()
  assert.deepEqual(core.avatarMap(), { W: UP_H })
  delete relay.avatars.W
  await core.refreshRoster()
  assert.deepEqual(core.avatarMap(), {})
  assert.equal(changes, 3)
  await core.stop(); await relay.close()
})

test('同步：別台設備送來不合格的圖不採用、不影響名單', async () => {
  const { relay, core } = await setup({ avatars: { W: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } })
  await core.refreshRoster()
  assert.deepEqual(core.avatarMap(), {})
  assert.equal(core.snapshot().friends.length, 1)
  await core.stop(); await relay.close()
})

test('上傳：成功後本機立刻換圖、其他人從名單取得；移除後改回自動產生', async () => {
  const { relay, core } = await setup()
  await core.refreshRoster()
  const r = await core.setSelfAvatar(UP_H)
  assert.equal(r.ok, true)
  assert.deepEqual(core.avatarMap(), { T: UP_H })
  assert.equal(relay.avatars.T.data, UP_H)
  const req = relay.reqs.find(q => q.action === 'set_avatar')
  assert.equal(req.method, 'POST')
  assert.deepEqual(Object.keys(req.body), ['avatar'])
  assert.equal((await core.setSelfAvatar(null)).ok, true)
  assert.deepEqual(core.avatarMap(), {})
  assert.equal(relay.avatars.T, undefined)
  await core.stop(); await relay.close()
})

test('上傳：格式不對的在本機就擋下，根本不送出；後端拒絕時回錯誤、本機不變', async () => {
  const { relay, core } = await setup()
  const bad = await core.setSelfAvatar('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')
  assert.equal(bad.ok, false)
  assert.ok(!relay.reqs.some(q => q.action === 'set_avatar'), '不合格的圖不該送出')
  // 後端自己也擋（假後端的規則同真後端）：繞過本機檢查直接送超長的圖，回白話代碼
  const huge = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(48000)
  await assert.rejects(() => core.transport.setAvatar(huge), /avatar_too_large/)
  await assert.rejects(() => core.transport.setAvatar('data:image/svg+xml;base64,PHN2Zz4='), /bad_avatar_format/)
  assert.equal((await core.setSelfAvatar(huge)).ok, false)
  assert.deepEqual(core.avatarMap(), {})
  await core.stop(); await relay.close()
})

test('存檔：好友在不在名單上的旗標會存下來，重開後離線的好友還記得', async () => {
  const relay = await startFakeRelay({ node: 'T', members: members() })
  const store = memStore()
  const core = new AsnCore({ transport: httpTransport(relay.url, NAME), store, selfNode: 'T', windowName: NAME, pollMs: 60_000, rosterMs: 60_000 })
  relay.mail(1, { from_node: 'W', from_agent: 'W-政策', to_agent: NAME })
  relay.mail(2, { from_node: 'K', from_agent: 'K-ASN', to_agent: NAME })
  await core.start(); await core.flush()
  assert.deepEqual(store.data.friends.map(f => [f.id, f.onRoster]).sort(), [['K/K-ASN', false], ['W/W-政策', true]])
  await core.stop(); await relay.close()
})

// 守門：介面真的用了這些規則（拿掉就紅）
test('守門：名單、對話區、提示、設定頁都接上大頭貼；上傳走 Rust 指令、不在前端直連', () => {
  const read = f => fs.readFileSync(path.join(UI, f), 'utf8')
  assert.ok(read('list.html').includes('avOf(c)') && read('list.html').includes('meAv') && read('list.html').includes('removeAvatar'))
  assert.ok(read('lib/chatpane.mjs').includes('friendAv') && read('lib/chatpane.mjs').includes('meAv'))
  assert.ok(!/\{\{\s*(friend\.dp|initial\(me\.nick\))\s*\}\}/.test(read('lib/chatpane.mjs')), '對話區不該再用單字色塊')
  assert.ok(read('toast.js').includes('blockieDataUrl') && read('toast.html').includes('t.src'))
  assert.ok(read('lib/tauri.mjs').includes("invoke('relay_set_avatar'") && read('lib/tauri.mjs').includes("invoke('relay_avatar'"))
  assert.ok(read('list.js').includes('avatarFor(n.friend'), '提示帶的圖要照顯示規則')
  assert.ok(read('lib/avatar-canvas.mjs').includes('squareCrop') && read('lib/avatar-canvas.mjs').includes('checkAvatarDataUrl'))
})
