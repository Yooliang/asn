// 畫面截圖比對（#1763 T2）的純邏輯：PNG 解碼／編碼、像素比對、結構快照的差異、中文字檢查、報告格式。
// 不開瀏覽器、不碰檔案系統（頁面內執行的原始碼字串也在這裡，由 ui-shots.mjs 注入），所以能直接單元測試（test/ui-shots-diff.test.mjs）。
import zlib from 'node:zlib'

// ---------- 命令列 ----------
export const DEFAULT_PIXEL_TOLERANCE = 0.001   // 允許差異的像素比例（0.1%）
export const DEFAULT_COLOR_TOLERANCE = 0       // 單點色差上限（四個通道各自的絕對差，0＝不容許）

const need = (flag, v) => { if (v === undefined || v === '') throw new Error(`${flag} 後面要接值`); return v }
const num = (flag, v, min, max) => { const n = Number(need(flag, v)); if (!(n >= min && n <= max)) throw new Error(`${flag} 要是 ${min}～${max} 的數字`); return n }
export const parseShotArgs = argv => {
  const o = { base: '', new: '', out: '', only: [], limit: 0, strict: false, pixelTolerance: DEFAULT_PIXEL_TOLERANCE, colorTolerance: DEFAULT_COLOR_TOLERANCE, timeoutMs: 15000, browser: '', list: false, jobs: 1, includeUnstable: false }
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], inline
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    if (eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq) }
    const val = () => inline !== undefined ? inline : argv[++i]
    if (a === '--strict') o.strict = true
    else if (a === '--list') o.list = true
    else if (a === '--include-unstable') o.includeUnstable = true
    else if (a === '--base') o.base = need(a, val())
    else if (a === '--new') o.new = need(a, val())
    else if (a === '--out') o.out = need(a, val())
    else if (a === '--only') o.only.push(...need(a, val()).split(',').filter(Boolean))
    else if (a === '--limit') o.limit = Math.floor(num(a, val(), 1, 100000))
    else if (a === '--pixel-tolerance') o.pixelTolerance = num(a, val(), 0, 1)
    else if (a === '--color-tolerance') o.colorTolerance = num(a, val(), 0, 255)
    else if (a === '--timeout') o.timeoutMs = num(a, val(), 1000, 600000)
    else if (a === '--jobs') o.jobs = Math.floor(num(a, val(), 1, 16))
    else if (a === '--browser') o.browser = need(a, val())
    else throw new Error(`不認得的參數：${argv[i]}`)
  }
  if (!o.list && (!o.base || !o.new)) throw new Error('要用 --base <ui 資料夾> --new <ui 資料夾> 指定兩份 ui')
  return o
}

// ---------- 情境挑選 ----------
export const scenarioWidth = s => s.width ?? (s.page.startsWith('m.html') ? 412 : 1100)
export const scenarioSkin = s => s.state?.skin ?? 'aero'
export const scenarioGroup = s => `${s.page.split('?')[0]}|${scenarioWidth(s)}|${scenarioSkin(s)}`
// 種子＝既有情境裡帶 shot 的子集；--only 是名稱片段（逗號分隔，任一符合）
// 已知「同一份程式碼每次畫面都不同」的情境（量到才加，要寫原因）：預設排除，報告頂端會列出；--include-unstable 才跑
export const UNSTABLE_SCENARIOS = {
  'm-line-table-360': '探測用手指甩動表格，慣性捲動的停點隨速度而變，每次差幾十像素（同一份程式碼跑 5 次，表格左緣 -128、-79、-123、-129…）',
  'm-line-table-412': '同上（同一個探測，412 寬）',
}
export const shotScenarios = (all, only = [], { includeUnstable = false } = {}) => all.filter(s => s.shot && (includeUnstable || !(s.name in UNSTABLE_SCENARIOS)) && (!only.length || only.some(f => s.name.includes(f))))
// --limit：照「頁面×寬度×外觀」輪流各取一個，再取第二個…，限量時矩陣也盡量涵蓋；回傳依原順序排列
export const sampleScenarios = (list, n) => {
  if (!n || n >= list.length) return list
  const groups = new Map()
  for (const s of list) { const k = scenarioGroup(s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s) }
  const picked = new Set()
  for (let round = 0; picked.size < n; round++) {
    let any = false
    for (const g of groups.values()) { if (round < g.length && picked.size < n) { picked.add(g[round]); any = true } }
    if (!any) break
  }
  return list.filter(s => picked.has(s))
}
// 矩陣：每個「頁面×寬度×外觀」有幾個情境；missing＝要求涵蓋但沒有的項目
export const REQUIRED_COVERAGE = [
  { label: '手機 412', test: s => s.page.startsWith('m.html') && scenarioWidth(s) === 412 },
  { label: '手機 360', test: s => s.page.startsWith('m.html') && scenarioWidth(s) === 360 },
  { label: '電腦 900', test: s => s.page.startsWith('list.html') && scenarioWidth(s) === 900 },
  { label: '外觀 aero', test: s => scenarioSkin(s) === 'aero' },
  { label: '外觀 modern', test: s => scenarioSkin(s) === 'modern' },
  { label: '外觀 line', test: s => scenarioSkin(s) === 'line' },
]
export const coverage = list => {
  const matrix = new Map()
  for (const s of list) matrix.set(scenarioGroup(s), (matrix.get(scenarioGroup(s)) ?? 0) + 1)
  return { matrix, missing: REQUIRED_COVERAGE.filter(r => !list.some(r.test)).map(r => r.label) }
}

// ---------- PNG ----------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
export const crc32 = buf => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

// 解 PNG：8 位元、非交錯；灰階／灰階＋透明／RGB／RGBA（瀏覽器截圖用 RGBA 或 RGB）。回傳 { width, height, data: Uint8Array(RGBA) }
export const decodePng = buf => {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG（檔頭不對）')
  let pos = 8, width = 0, height = 0, color = -1
  const idat = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8)
    const body = buf.subarray(pos + 8, pos + 8 + len)
    if (body.length < len) throw new Error('PNG 被截斷')
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); color = body[9]
      if (body[8] !== 8) throw new Error(`只支援 8 位元 PNG（這張是 ${body[8]} 位元）`)
      if (body[12] !== 0) throw new Error('不支援交錯（interlaced）PNG')
      if (![0, 2, 4, 6].includes(color)) throw new Error(`不支援的 PNG 色彩類型 ${color}`)
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (!width || !height) throw new Error('PNG 缺 IHDR')
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[color]
  const stride = width * ch
  const raw = zlib.inflateSync(Buffer.concat(idat))
  if (raw.length !== (stride + 1) * height) throw new Error('PNG 像素資料長度不對')
  const px = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[dst + x - ch] : 0, b = y ? px[up + x] : 0, c = x >= ch && y ? px[up + x - ch] : 0
      let v = raw[src + x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      else if (f !== 0) throw new Error(`PNG 濾波類型 ${f} 不認得`)
      px[dst + x] = v & 255
    }
  }
  const data = new Uint8Array(width * height * 4)
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * ch, d = i * 4
    if (ch === 4) { data[d] = px[s]; data[d + 1] = px[s + 1]; data[d + 2] = px[s + 2]; data[d + 3] = px[s + 3] }
    else if (ch === 3) { data[d] = px[s]; data[d + 1] = px[s + 1]; data[d + 2] = px[s + 2]; data[d + 3] = 255 }
    else { data[d] = data[d + 1] = data[d + 2] = px[s]; data[d + 3] = ch === 2 ? px[s + 1] : 255 }
  }
  return { width, height, data }
}

const chunk = (type, body) => {
  const out = Buffer.alloc(12 + body.length)
  out.writeUInt32BE(body.length, 0); out.write(type, 4, 'latin1'); Buffer.from(body).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
  return out
}
// 編 RGBA 8 位元 PNG（濾波類型 0；差異圖用）
export const encodePng = ({ width, height, data }) => {
  const stride = width * 4, raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}

// ---------- 像素比對 ----------
// 兩張同尺寸：任一通道絕對差 > colorTolerance 的像素算「不同」。尺寸不同＝整張不同（sizeMismatch）。
// 回傳 { width, height, total, diff, ratio, maxDelta, sizeMismatch, diffImage }（diffImage：底圖淡化、不同的像素塗紅）
export const compareImages = (a, b, { colorTolerance = DEFAULT_COLOR_TOLERANCE, makeImage = true } = {}) => {
  if (a.width !== b.width || a.height !== b.height) {
    const total = Math.max(a.width * a.height, b.width * b.height)
    return { width: Math.max(a.width, b.width), height: Math.max(a.height, b.height), total, diff: total, ratio: 1, maxDelta: 255, sizeMismatch: true, diffImage: null }
  }
  const n = a.width * a.height, A = a.data, B = b.data
  const out = makeImage ? new Uint8Array(n * 4) : null
  let diff = 0, maxDelta = 0
  for (let i = 0; i < n; i++) {
    const o = i * 4
    let d = 0
    if (A[o] !== B[o] || A[o + 1] !== B[o + 1] || A[o + 2] !== B[o + 2] || A[o + 3] !== B[o + 3]) {
      d = Math.max(Math.abs(A[o] - B[o]), Math.abs(A[o + 1] - B[o + 1]), Math.abs(A[o + 2] - B[o + 2]), Math.abs(A[o + 3] - B[o + 3]))
    }
    if (d > maxDelta) maxDelta = d
    const bad = d > colorTolerance
    if (bad) diff++
    if (out) {
      if (bad) { out[o] = 255; out[o + 1] = 0; out[o + 2] = 64; out[o + 3] = 255 }
      else { const g = (A[o] * 30 + A[o + 1] * 59 + A[o + 2] * 11) / 100; const v = 255 - (255 - g) * 0.3; out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255 }
    }
  }
  return { width: a.width, height: a.height, total: n, diff, ratio: n ? diff / n : 0, maxDelta, sizeMismatch: false, diffImage: out ? { width: a.width, height: a.height, data: out } : null }
}
// 單色（整張同一個顏色）＝多半是空白頁（R9：截圖是空白頁不能算通過）
export const isMonochrome = img => {
  const d = img.data
  for (let i = 4; i < d.length; i += 4) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2] || d[i + 3] !== d[3]) return false
  return true
}
// 並排圖：基準 | 新 | 差異（高度取最高，缺的地方留灰；中間隔 8 像素）
export const sideBySide = (imgs, gap = 8) => {
  const h = Math.max(...imgs.map(i => i.height)), w = imgs.reduce((s, i) => s + i.width, 0) + gap * (imgs.length - 1)
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = 128; data[i + 3] = 255 }
  let x0 = 0
  for (const im of imgs) {
    for (let y = 0; y < im.height; y++) data.set(im.data.subarray(y * im.width * 4, (y + 1) * im.width * 4), (y * w + x0) * 4)
    x0 += im.width + gap
  }
  return { width: w, height: h, data }
}

// ---------- 結構快照 ----------
// 兩份已排序的行；回傳 { removed, added, text }。先剝共同頭尾，中間用 LCS（太大就退回集合差）
export const diffLines = (a, b) => {
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let ea = a.length, eb = b.length
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb-- }
  const x = a.slice(s, ea), y = b.slice(s, eb)
  const ops = []
  if (!x.length && !y.length) return { removed: [], added: [], text: '' }
  if (x.length * y.length > 4_000_000) {
    const sy = new Set(y), sx = new Set(x)
    for (const l of x) if (!sy.has(l)) ops.push({ t: '-', line: l })
    for (const l of y) if (!sx.has(l)) ops.push({ t: '+', line: l })
  } else {
    const W = y.length + 1, L = new Uint32Array((x.length + 1) * W)
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i * W + j] = x[i] === y[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1])
    let i = 0, j = 0
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) { i++; j++ }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) ops.push({ t: '-', line: x[i++] })
      else ops.push({ t: '+', line: y[j++] })
    }
    while (i < x.length) ops.push({ t: '-', line: x[i++] })
    while (j < y.length) ops.push({ t: '+', line: y[j++] })
  }
  const removed = ops.filter(o => o.t === '-').map(o => o.line), added = ops.filter(o => o.t === '+').map(o => o.line)
  return { removed, added, text: ops.map(o => `${o.t} ${o.line}`).join('\n') + '\n' }
}

// ---------- 中文字確實有畫出來 ----------
// 在頁面量：一段中文與「同長度的私用區字元 U+E000」的渲染寬度；缺 CJK 字型時兩者都畫成缺字方框，寬度幾乎一樣。
// pixelsIdentical：同一字型各畫一次到 canvas，像素完全一樣＝畫的是同一個框（可省略）。
export const CJK_SAMPLE = '設定設定設定'
export const TOFU_SAMPLE = ''.repeat([...CJK_SAMPLE].length)
export const cjkVerdict = ({ cjkWidth, tofuWidth, pixelsIdentical } = {}) => {
  const ok = v => typeof v === 'number' && Number.isFinite(v) && v > 0
  if (!ok(cjkWidth) || !ok(tofuWidth)) return { ok: false, why: `量不到文字寬度（中文 ${cjkWidth}、方框 ${tofuWidth}）` }
  const rel = Math.abs(cjkWidth - tofuWidth) / Math.max(cjkWidth, tofuWidth)
  if (pixelsIdentical === true) return { ok: false, why: '中文字與缺字方框畫成一模一樣，這台機器多半沒有 CJK 字型' }
  // 有 CJK 字型時缺字的私用區字元也可能畫成同寬的方框（Noto CJK：中文字與方框都是全形寬），寬度一樣不能當缺字；
  // 字的像素和方框不一樣＝真的畫出了字形（2026-11-19 CI 實跑：runner 裝了 fonts-noto-cjk 後寬度同為 192px，被誤判）
  if (pixelsIdentical === false) return { ok: true, why: `中文字的字形與缺字方框不同（中文寬 ${cjkWidth.toFixed(1)}px、方框寬 ${tofuWidth.toFixed(1)}px）` }
  if (rel < 0.05) return { ok: false, why: `中文寬 ${cjkWidth.toFixed(1)}px 與方框寬 ${tofuWidth.toFixed(1)}px 幾乎相同（差 ${(rel * 100).toFixed(1)}%），這台機器多半沒有 CJK 字型` }
  return { ok: true, why: `中文寬 ${cjkWidth.toFixed(1)}px、方框寬 ${tofuWidth.toFixed(1)}px（差 ${(rel * 100).toFixed(1)}%）` }
}
export const cjkProbeSource = () => `(() => {
  const mk = t => { const s = document.createElement('span'); s.textContent = t; s.style.cssText = 'position:absolute;left:0;top:0;white-space:nowrap;font-size:32px;visibility:hidden'; document.body.appendChild(s); const w = s.getBoundingClientRect().width; s.remove(); return w };
  const cjkWidth = mk(${JSON.stringify(CJK_SAMPLE)}), tofuWidth = mk(${JSON.stringify(TOFU_SAMPLE)});
  let pixelsIdentical;
  try {
    const px = t => { const c = document.createElement('canvas'); c.width = 48; c.height = 48; const g = c.getContext('2d'); g.font = '32px ' + getComputedStyle(document.body).fontFamily; g.fillText(t, 4, 36); return g.getImageData(0, 0, 48, 48).data };
    const a = px('設'), b = px('\\uE000'); pixelsIdentical = a.length === b.length && a.every((v, i) => v === b[i]);
  } catch { /* 沒有 canvas 就只看寬度 */ }
  return { cjkWidth, tofuWidth, pixelsIdentical, font: getComputedStyle(document.body).fontFamily };
})()`

// ---------- 頁面內執行的原始碼 ----------
// 固定假的現在時間：Date.now 與 new Date() 從 fixedMs 起算，之後跟著真實經過的時間走（不能整個凍住：雙擊、長按、逾時判斷都要看時間差）
export const clockSource = fixedMs => `(() => {
  const Real = Date, t0 = performance.now(), base = ${Math.floor(fixedMs)};
  const now = () => base + Math.floor(performance.now() - t0);
  function FakeDate(...a) { if (!new.target) return new Real(now()).toString(); return a.length ? new Real(...a) : new Real(now()) }
  FakeDate.prototype = Real.prototype; FakeDate.now = now; FakeDate.parse = Real.parse; FakeDate.UTC = Real.UTC;
  Object.setPrototypeOf(FakeDate, Real);
  globalThis.Date = FakeDate;
})();`
// 截圖前凍住畫面：游標不閃、轉場與動畫停住、捲動不平滑；再等字型載完與兩格畫面
export const freezeSource = () => `(async () => {
  const st = document.createElement('style');
  st.textContent = '*,*::before,*::after{caret-color:transparent!important;transition:none!important;animation:none!important;scroll-behavior:auto!important}';
  document.head.appendChild(st);
  await document.fonts.ready;
  // 慣性捲動還沒停就截圖，每次會停在不同位置：等所有可捲動元素的位置連續 4 次（約 0.4 秒）不再變動，最多等 4 秒
  const pos = () => { let h = 0; for (const e of document.querySelectorAll('*')) { if (e.scrollLeft || e.scrollTop) h = (h * 31 + Math.round(e.scrollLeft * 100) + 7 * Math.round(e.scrollTop * 100)) % 1000000007 } return h + ':' + scrollX + ':' + scrollY };
  let last = pos(), still = 0;
  for (let t = 0; t < 4000 && still < 4; t += 100) { await new Promise(r => setTimeout(r, 100)); const p = pos(); still = p === last ? still + 1 : 0; last = p }
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { ok: true, fonts: document.fonts.size, dpr: devicePixelRatio, scale: visualViewport ? visualViewport.scale : 1 };
})()`
// 結構快照：可見元素一行一個，排序固定；不列 class／id。位置取整數像素。
export const SNAPSHOT_STYLES = ['display', 'position', 'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-color', 'border-radius', 'padding', 'margin', 'min-height', 'min-width', 'gap', 'opacity', 'overflow-x', 'overflow-y', 'box-shadow', 'transform', 'text-align']
export const snapshotSource = () => `(() => {
  const props = ${JSON.stringify(SNAPSHOT_STYLES)};
  const dflt = new Set(['none', 'normal', '0px', 'auto', 'static', 'rgba(0, 0, 0, 0)', 'visible', '1', 'start', 'inline', '0px 0px 0px 0px']);
  const skip = new Set(['SCRIPT', 'STYLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'TITLE']);
  const rows = [];
  const short = p => p.replace(/^border-/, 'b-').replace('background-color', 'bg').replace('font-', 'f-');
  const walk = el => {
    if (skip.has(el.tagName)) return;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const shown = (r.width > 0 || r.height > 0) && cs.visibility !== 'hidden' && cs.display !== 'none';
    if (shown) {
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').replace(/\\s+/g, ' ').trim().slice(0, 60);
      const val = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'password' ? String(el.value || '').slice(0, 40) : '';
      const st = props.map(p => {
        let v = cs.getPropertyValue(p);
        if (p === 'padding' || p === 'margin') v = ['top', 'right', 'bottom', 'left'].map(s => cs.getPropertyValue(p + '-' + s)).join(' ');
        return dflt.has(v) ? '' : short(p) + '=' + v;
      }).filter(Boolean).join(' ');
      const x = Math.round(r.left), y = Math.round(r.top), w = Math.round(r.width), h = Math.round(r.height);
      rows.push({ x, y, line: el.tagName.toLowerCase() + ' @' + x + ',' + y + ' ' + w + 'x' + h + (own ? ' "' + own + '"' : '') + (val ? ' value="' + val + '"' : '') + ' | ' + st });
    }
    if (el.tagName.toLowerCase() === 'svg') return;
    for (const c of el.children) walk(c);
  };
  walk(document.documentElement);
  rows.sort((a, b) => a.y - b.y || a.x - b.x || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
  return rows.map(r => r.line);
})()`

// ---------- 報告 ----------
const pct = r => `${(r * 100).toFixed(3)}%`
export const rowStatus = (row, { pixelTolerance = DEFAULT_PIXEL_TOLERANCE } = {}) => {
  if (row.error) return 'error'
  if (row.blank) return 'blank'
  if (row.structDiff > 0) return 'diff'
  if (row.pixel && (row.pixel.sizeMismatch || row.pixel.ratio > pixelTolerance)) return 'diff'
  return 'ok'
}
// rows：[{ name, page, width, skin, structDiff, pixel, error?, blank?, note? }]；回傳 markdown
export const formatReport = ({ rows, meta = {}, cjk = null, coverageMissing = [], opts = {} }) => {
  const tol = opts.pixelTolerance ?? DEFAULT_PIXEL_TOLERANCE
  const status = rows.map(r => rowStatus(r, { pixelTolerance: tol }))
  const bad = status.filter(s => s !== 'ok').length
  const cell = (s, n) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, n)
  const L = []
  L.push('# 畫面截圖比對報告', '')
  const broken = toolBroken({ rows, meta, cjk })
  if (cjk && !cjk.ok && !cjk.missing) L.push(`> **🔴 警告：中文字沒有確實畫出來。** ${cjk.why}。截圖會「一致地」全是方框，比對結果不可信。`, '')
  if (broken) L.push(`> **🔴 比對工具自己壞了，下面的結果不能當成「沒有差異」：** ${broken}`, '')
  if (meta.skipped) L.push(`> 已略過：${meta.skipped}`, '')
  if (meta.excluded?.length) L.push(`> 已知不穩定、預設排除的情境：${meta.excluded.map(([n, why]) => `${n}（${why}）`).join('；')}`, '')
  if (coverageMissing.length) L.push(`> 警告：情境集合缺少 ${coverageMissing.join('、')}`, '')
  L.push(`- 基準：\`${meta.base ?? ''}\``, `- 新版：\`${meta.new ?? ''}\``)
  if (meta.browser) L.push(`- 瀏覽器：${meta.browser}`)
  if (cjk) L.push(`- 中文字檢查：${cjk.ok ? '通過' : '失敗'}（${cjk.why}）`)
  L.push(`- 容忍度：不同像素比例 ≤ ${pct(tol)}、單點色差 ≤ ${opts.colorTolerance ?? DEFAULT_COLOR_TOLERANCE}`)
  L.push(`- 情境：${rows.length ? `${rows.length} 個，有差異或錯誤 ${bad} 個` : '沒有跑任何情境'}${meta.seconds !== undefined ? `；耗時 ${meta.seconds} 秒${rows.length ? `（每情境平均 ${(meta.seconds / rows.length).toFixed(1)} 秒，含基準與新版各跑一次）` : ''}` : ''}`)
  L.push('')
  if (!rows.length) return L.join('\n') + '\n'
  L.push('| 情境 | 頁面 | 寬 | 外觀 | 結構差異行數 | 像素差異比例 | 結果 |', '| --- | --- | ---: | --- | ---: | ---: | --- |')
  rows.forEach((r, i) => {
    const s = status[i]
    const px = r.pixel ? (r.pixel.sizeMismatch ? '尺寸不同' : pct(r.pixel.ratio)) : '—'
    const res = s === 'ok' ? '通過' : s === 'diff' ? '**有差異**' : s === 'blank' ? '**單色（空白頁？）**' : `**錯誤**：${cell(r.error, 200)}`
    L.push(`| ${r.name} | ${r.page} | ${r.width} | ${r.skin} | ${r.structDiff ?? '—'} | ${px} | ${res}${r.note ? `（${cell(r.note, 160)}）` : ''} |`)
  })
  L.push('')
  return L.join('\n')
}
// 工具自己壞了（不是畫面有差異）：回原因，沒壞回空字串。壞了就不能把「沒有差異」當結論；結束碼固定非 0（不看 --strict）
export const toolBroken = ({ rows = [], meta = {}, cjk = null } = {}) => {
  if (meta.skipped) return `沒有跑：${meta.skipped}`
  const whole = rows.find(r => r.name === '(整體)')
  if (whole) return `整體出錯：${whole.error}`
  if (cjk && !cjk.ok) return cjk.missing ? cjk.why : `中文字檢查失敗：${cjk.why}`
  return ''
}
// 是否該判失敗（--strict）：有任何非通過的情境、中文字檢查失敗、或情境數量對不上
export const strictFailed = ({ rows, cjk, opts = {}, countMismatch = false }) =>
  !!(countMismatch || (cjk && !cjk.ok) || rows.some(r => rowStatus(r, { pixelTolerance: opts.pixelTolerance }) !== 'ok'))
