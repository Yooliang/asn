// 畫面截圖比對（#1763 T2）的純邏輯測試：不開瀏覽器。PNG 用程式合成（含 filter 0–4）。
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import zlib from 'node:zlib'
import { SCENARIOS } from '../scripts/smoke-lib.mjs'
import {
  DEFAULT_COLOR_TOLERANCE, DEFAULT_PIXEL_TOLERANCE, cjkProbeSource, cjkVerdict, clockSource, compareImages, coverage, crc32, decodePng, diffLines, encodePng,
  formatReport, isMonochrome, parseShotArgs, rowStatus, sampleScenarios, shotScenarios, sideBySide, snapshotSource, strictFailed, UNSTABLE_SCENARIOS,
} from '../scripts/ui-shots-lib.mjs'

// 合成圖：fn(x, y) -> [r, g, b, a]
const make = (w, h, fn) => { const data = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fn(x, y), (y * w + x) * 4); return { width: w, height: h, data } }
const solid = (w, h, c) => make(w, h, () => c)

// 手工編一張指定 filter 的 PNG（RGBA 或 RGB），用來驗證解碼器的五種 filter 都對
const chunkOf = (type, body) => { const b = Buffer.alloc(12 + body.length); b.writeUInt32BE(body.length, 0); b.write(type, 4, 'latin1'); Buffer.from(body).copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + body.length)), 8 + body.length); return b }
const pngWithFilter = (img, filter, ch = 4) => {
  const stride = img.width * ch, raw = Buffer.alloc((stride + 1) * img.height)
  const px = (x, y, c) => (x < 0 || y < 0) ? 0 : img.data[(y * img.width + x) * 4 + c]
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = filter
    for (let x = 0; x < img.width; x++) for (let c = 0; c < ch; c++) {
      const cur = px(x, y, c), a = px(x - 1, y, c), b = px(x, y - 1, c), cc = px(x - 1, y - 1, c)
      let pred = 0
      if (filter === 1) pred = a; else if (filter === 2) pred = b; else if (filter === 3) pred = (a + b) >> 1
      else if (filter === 4) { const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc }
      raw[y * (stride + 1) + 1 + x * ch + c] = (cur - pred) & 255
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(img.width, 0); ihdr.writeUInt32BE(img.height, 4); ihdr[8] = 8; ihdr[9] = ch === 4 ? 6 : 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunkOf('IHDR', ihdr), chunkOf('IDAT', zlib.deflateSync(raw)), chunkOf('IEND', Buffer.alloc(0))])
}

test('crc32：已知值（"123456789" = cbf43926）', () => assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926))

test('PNG：五種 filter 的 RGBA 都解得回原圖', () => {
  const img = make(7, 5, (x, y) => [(x * 37 + y * 11) & 255, (x * 5 + y * 91) & 255, (x * y * 13) & 255, 255 - ((x + y) & 3)])
  for (const f of [0, 1, 2, 3, 4]) assert.deepEqual(decodePng(pngWithFilter(img, f)).data, img.data, `filter ${f}`)
})
test('PNG：RGB（沒有透明）解成不透明 RGBA；encode 後再 decode 不變', () => {
  const img = make(6, 4, (x, y) => [x * 40, y * 60, 7, 255])
  assert.deepEqual(decodePng(pngWithFilter(img, 4, 3)).data, img.data)
  const back = decodePng(encodePng(img))
  assert.equal(back.width, 6); assert.equal(back.height, 4); assert.deepEqual(back.data, img.data)
})
test('PNG：壞檔給清楚的錯誤', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /不是 PNG/)
  const ok = encodePng(solid(3, 3, [1, 2, 3, 255]))
  assert.throws(() => decodePng(ok.subarray(0, ok.length - 20)), /截斷|長度|incomplete|unexpected/i)
})

test('像素比對：合成兩張圖，差異像素數正好等於預期', () => {
  const a = solid(40, 30, [255, 255, 255, 255])
  const b = solid(40, 30, [255, 255, 255, 255])
  let expected = 0
  for (let y = 5; y < 9; y++) for (let x = 10; x < 17; x++) { b.data.set([0, 0, 0, 255], (y * 40 + x) * 4); expected++ }
  const r = compareImages(a, b)
  assert.equal(r.diff, expected); assert.equal(r.total, 1200); assert.equal(r.ratio, expected / 1200); assert.equal(r.maxDelta, 255)
  assert.equal(r.diffImage.width, 40)
  // 差異圖：不同的像素是紅、相同的是淺灰
  const at = (x, y) => [...r.diffImage.data.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 4)]
  assert.deepEqual(at(10, 5), [255, 0, 64, 255])
  assert.ok(at(0, 0)[0] > 200 && at(0, 0)[0] === at(0, 0)[1])
})
test('像素比對：同一張圖 0 差異；色差容忍度生效；尺寸不同＝整張不同', () => {
  const a = make(8, 8, (x, y) => [x * 30, y * 30, 100, 255])
  assert.equal(compareImages(a, a).diff, 0)
  const b = make(8, 8, (x, y) => [x * 30 + (x === 3 ? 3 : 0), y * 30, 100, 255])
  assert.equal(compareImages(a, b).diff, 8)
  assert.equal(compareImages(a, b, { colorTolerance: 3 }).diff, 0, '差 3 且容忍 3 就不算')
  assert.equal(compareImages(a, b, { colorTolerance: 2 }).diff, 8)
  const c = compareImages(a, solid(8, 9, [0, 0, 0, 255]))
  assert.equal(c.sizeMismatch, true); assert.equal(c.ratio, 1)
  assert.equal(DEFAULT_COLOR_TOLERANCE, 0); assert.equal(DEFAULT_PIXEL_TOLERANCE, 0.001)
})
test('像素比對：900x640 的速度只做記錄（不設門檻，只確認有跑完且結果對）', () => {
  const a = make(900, 640, (x, y) => [x & 255, y & 255, (x ^ y) & 255, 255]), b = make(900, 640, (x, y) => [x & 255, y & 255, (x ^ y) & 255, 255])
  b.data[4] ^= 1
  const t = process.hrtime.bigint()
  const r = compareImages(a, b, { makeImage: false })
  const ms = Number(process.hrtime.bigint() - t) / 1e6
  assert.equal(r.diff, 1); assert.equal(r.diffImage, null)
  console.log(`  # 900x640 逐像素比對 ${ms.toFixed(1)} ms`)
})
test('單色判斷（R9：空白頁）與並排圖', () => {
  assert.equal(isMonochrome(solid(5, 5, [9, 9, 9, 255])), true)
  assert.equal(isMonochrome(make(5, 5, (x, y) => [x === 4 && y === 4 ? 1 : 0, 0, 0, 255])), false)
  const s = sideBySide([solid(3, 2, [1, 1, 1, 255]), solid(4, 5, [2, 2, 2, 255])], 2)
  assert.equal(s.width, 9); assert.equal(s.height, 5)
  assert.deepEqual([...s.data.subarray(0, 4)], [1, 1, 1, 255])
  assert.deepEqual([...s.data.subarray((0 * 9 + 5) * 4, (0 * 9 + 5) * 4 + 4)], [2, 2, 2, 255])
})

test('結構快照差異：相同＝0；改一行＝移除 1 加入 1；增刪；順序固定', () => {
  const a = ['div @0,0 10x10 | f-size=12px', 'span @0,20 5x5 "設定" | color=red', 'p @0,40 5x5 | ']
  assert.deepEqual(diffLines(a, [...a]), { removed: [], added: [], text: '' })
  const b = [...a]; b[1] = 'span @0,20 5x5 "設定" | color=blue'
  const d = diffLines(a, b)
  assert.deepEqual(d.removed, [a[1]]); assert.deepEqual(d.added, [b[1]])
  assert.match(d.text, /^- span.*red\n\+ span.*blue\n$/)
  assert.deepEqual(diffLines(a, a.slice(0, 2)).removed, [a[2]])
  assert.deepEqual(diffLines(a.slice(1), a).added, [a[0]])
  assert.equal(diffLines([], a).added.length, 3)
})
test('結構快照差異：很大的差異退回集合差、不會卡住', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`), b = Array.from({ length: 3000 }, (_, i) => `b${i}`)
  const d = diffLines(a, b)
  assert.equal(d.removed.length, 3000); assert.equal(d.added.length, 3000)
})
test('結構快照的頁面端原始碼：能解析；不列 class／id；排序固定', () => {
  const src = snapshotSource()
  assert.doesNotThrow(() => new vm.Script(src))
  assert.ok(!/className|getAttribute\('class'\)|\.id\b/.test(src), '不能把 class／id 放進快照')
  assert.ok(src.includes('Math.round') && src.includes('rows.sort'))
  for (const p of ['font-size', 'color', 'background-color', 'min-height', 'padding']) assert.ok(src.includes(p), p)
})
test('假的現在時間：Date.now 與 new Date() 從固定值起算、其他 Date 用法照舊', () => {
  const ctx = vm.createContext({ performance, globalThis: null })
  ctx.globalThis = ctx
  vm.runInContext(`globalThis.Date = Date;` + clockSource(Date.UTC(2026, 10, 1)), ctx)
  const fixed = Date.UTC(2026, 10, 1)
  const n = vm.runInContext('Date.now()', ctx)
  assert.ok(n >= fixed && n < fixed + 1000, `Date.now ${n}`)
  const d = vm.runInContext('new Date()', ctx)
  assert.ok(d.getTime() >= fixed && d.getTime() < fixed + 1000)
  assert.equal(vm.runInContext('new Date(2020, 0, 2).getFullYear()', ctx), 2020)
  assert.equal(vm.runInContext('new Date("2021-05-06T00:00:00Z").getTime()', ctx), Date.UTC(2021, 4, 6))
  assert.equal(vm.runInContext('new Date() instanceof Date', ctx), true)
  assert.equal(vm.runInContext('Date.UTC(2000, 0, 1)', ctx), Date.UTC(2000, 0, 1))
})

test('中文字檢查：寬度差夠大＝有畫；幾乎相同＝缺字型；量不到＝失敗', () => {
  assert.equal(cjkVerdict({ cjkWidth: 192, tofuWidth: 124 }).ok, true)
  const same = cjkVerdict({ cjkWidth: 192, tofuWidth: 192 })
  assert.equal(same.ok, false); assert.match(same.why, /CJK 字型/)
  assert.equal(cjkVerdict({ cjkWidth: 192, tofuWidth: 190 }).ok, false, '差 1% 算缺字')
  assert.equal(cjkVerdict({ cjkWidth: 192, tofuWidth: 150, pixelsIdentical: true }).ok, false, '像素一模一樣也算缺字')
  assert.equal(cjkVerdict({ cjkWidth: 192, tofuWidth: 150, pixelsIdentical: false }).ok, true)
  // 有 CJK 字型時方框與中文同寬（runner 實測 192／192），但字形不同：不能當缺字
  assert.equal(cjkVerdict({ cjkWidth: 192, tofuWidth: 192, pixelsIdentical: false }).ok, true)
  assert.equal(cjkVerdict({ cjkWidth: 192, tofuWidth: 192, pixelsIdentical: true }).ok, false)
  for (const bad of [{}, { cjkWidth: 0, tofuWidth: 5 }, { cjkWidth: NaN, tofuWidth: 5 }, { cjkWidth: 5, tofuWidth: undefined }]) assert.equal(cjkVerdict(bad).ok, false)
  assert.doesNotThrow(() => new vm.Script(cjkProbeSource()))
})

test('命令列：必要參數、預設值、錯誤', () => {
  const o = parseShotArgs(['--base', 'a', '--new=b', '--only', 'm-a,list-b', '--limit', '5', '--strict', '--pixel-tolerance', '0.01'])
  assert.deepEqual([o.base, o.new, o.only, o.limit, o.strict, o.pixelTolerance], ['a', 'b', ['m-a', 'list-b'], 5, true, 0.01])
  assert.equal(parseShotArgs(['--base', 'a', '--new', 'b']).pixelTolerance, 0.001)
  assert.equal(parseShotArgs(['--base', 'a', '--new', 'b']).strict, false)
  assert.throws(() => parseShotArgs(['--base', 'a']), /--new/)
  assert.throws(() => parseShotArgs(['--base', 'a', '--new', 'b', '--zzz']), /不認得/)
  assert.throws(() => parseShotArgs(['--base', 'a', '--new', 'b', '--pixel-tolerance', '2']), /0～1/)
  assert.equal(parseShotArgs(['--list']).list, true)
})

test('情境：種子是帶 shot 的子集；矩陣涵蓋 412／360／900 與三套外觀；--limit 輪流取各組', () => {
  const all = shotScenarios(SCENARIOS)
  assert.ok(all.length > 100 && all.every(s => s.shot))
  assert.equal(new Set(all.map(s => s.name)).size, all.length, '情境名稱不重複（輸出檔用名稱）')
  assert.deepEqual(coverage(all).missing, [])
  assert.deepEqual(coverage(all.filter(s => s.page.startsWith('m.html'))).missing, ['電腦 900'])
  assert.ok(!all.some(s => s.name in UNSTABLE_SCENARIOS), '不穩定的情境預設排除')
  assert.ok(shotScenarios(SCENARIOS, [], { includeUnstable: true }).length > all.length)
  for (const n of Object.keys(UNSTABLE_SCENARIOS)) assert.ok(SCENARIOS.some(s => s.name === n && s.shot), `${n} 要真的存在，不然排除名單是死的`)
  assert.deepEqual(shotScenarios(SCENARIOS, ['m-acct-cards']).map(s => s.name), ['m-acct-cards'])
  const few = sampleScenarios(all, 24)
  assert.equal(few.length, 24)
  const groups = new Set(few.map(s => `${s.page}|${s.width ?? ''}|${s.state.skin ?? 'aero'}`))
  assert.ok(groups.size >= 12, `限量時要盡量涵蓋各組（${groups.size} 組）`)
  assert.deepEqual(sampleScenarios(all, 24), few, '挑選是固定的')
  assert.equal(sampleScenarios(all, 0), all)
})

test('報告：每情境一行；有差異標出；中文字警告在最上面；耗時；錯誤與單色', () => {
  const rows = [
    { name: 'a', page: 'm.html', width: 412, skin: 'aero', structDiff: 0, pixel: { ratio: 0, sizeMismatch: false } },
    { name: 'b', page: 'list.html', width: 900, skin: 'modern', structDiff: 4, pixel: { ratio: 0.0123, sizeMismatch: false } },
    { name: 'c', page: 'm.html', width: 360, skin: 'line', error: '沒有掛上 | x' },
    { name: 'd', page: 'm.html', width: 360, skin: 'line', structDiff: 0, pixel: { ratio: 0, sizeMismatch: false }, blank: true },
    { name: 'e', page: 'm.html', width: 360, skin: 'line', structDiff: 0, pixel: { ratio: 0.0005, sizeMismatch: false } },
  ]
  const md = formatReport({ rows, meta: { base: 'B', new: 'N', seconds: 50 }, cjk: { ok: false, why: '沒有 CJK 字型' }, opts: {} })
  assert.match(md.split('\n').slice(0, 4).join('\n'), /🔴 警告：中文字沒有確實畫出來/)
  assert.match(md, /\| a \| m\.html \| 412 \| aero \| 0 \| 0\.000% \| 通過 \|/)
  assert.match(md, /\| b \| list\.html \| 900 \| modern \| 4 \| 1\.230% \| \*\*有差異\*\* \|/)
  assert.match(md, /\*\*錯誤\*\*：沒有掛上 \\\| x/)
  assert.match(md, /單色/)
  assert.match(md, /\| e \|.*\| 通過 \|/, '0.05% 在容忍度 0.1% 以內')
  assert.match(md, /有差異或錯誤 3 個；耗時 50 秒（每情境平均 10\.0 秒/)
  assert.equal(formatReport({ rows: [], meta: { skipped: '找不到 Chrome' } }).includes('已略過：找不到 Chrome'), true)
  assert.ok(!formatReport({ rows, cjk: { ok: true, why: 'x' } }).includes('🔴'))
})
test('--strict 的判定：全過＝不失敗；任一差異、中文字失敗、數量對不上＝失敗', () => {
  const ok = [{ name: 'a', structDiff: 0, pixel: { ratio: 0 } }]
  assert.equal(strictFailed({ rows: ok, cjk: { ok: true } }), false)
  assert.equal(strictFailed({ rows: [{ ...ok[0], structDiff: 1 }], cjk: { ok: true } }), true)
  assert.equal(strictFailed({ rows: [{ ...ok[0], pixel: { ratio: 0.5 } }], cjk: { ok: true } }), true)
  assert.equal(strictFailed({ rows: ok, cjk: { ok: false } }), true)
  assert.equal(strictFailed({ rows: ok, cjk: { ok: true }, countMismatch: true }), true)
  assert.equal(rowStatus({ pixel: { sizeMismatch: true, ratio: 1 } }), 'diff')
})
