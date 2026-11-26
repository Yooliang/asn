// 冒煙探測「長圖寄出」（probe.longPhoto，#2331）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 在頁面裡用 canvas 造兩張長圖（設計稿合一長圖 1162×3604、手機全頁截圖 1080×5000），餵給正式寄出用的 imageFromBlob（canvas → webp 同一條路徑），
// 量輸出寬高與檔案大小；同時用舊規則（長邊 2048、品質 0.88）量一份對照。
// 斷言：新規則下寬度不縮（1162、1080）、高度不縮，檔案 ≤ 1.5 MB；舊規則的寬度必須比新規則窄（確認這支探測真的量得到差別）。
// 量測數字由 smoke-ui 以「量測 …」印出。

export const LONG_PHOTO_MAX_BYTES = 1.5 * 1024 * 1024

export const longPhotoProbeSource = () => `(async () => {
  try {
  const MAX = ${LONG_PHOTO_MAX_BYTES};
  const { imageFromBlob } = await import('/lib/photo-canvas.mjs');
  const { fitSize } = await import('/lib/photo.mjs');
  let seed = 20261126;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 };
  const WORDS = ['訂單編號', '付款方式', 'Order', 'Total', '收件人', 'Quantity', '設計稿', 'Header', '備註', 'Subtotal', '數量', 'Status'];
  const line = n => { let s = ''; for (let i = 0; i < n; i++) s += WORDS[Math.floor(rnd() * WORDS.length)] + ' ' + Math.floor(rnd() * 9999) + '  '; return s };
  const toPng = cv => new Promise(res => cv.toBlob(b => res(b), 'image/png'));
  // (a) 設計稿合一長圖：白底，6 格，每格排滿 12 px 細字與表格線
  const designSheet = async () => {
    const cv = document.createElement('canvas'); cv.width = 1162; cv.height = 3604;
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 1162, 3604);
    const cell = 3604 / 6;
    for (let c = 0; c < 6; c++) {
      const y0 = Math.round(c * cell);
      g.strokeStyle = '#999'; g.lineWidth = 1; g.strokeRect(10.5, y0 + 10.5, 1141, cell - 20);
      g.fillStyle = '#111'; g.font = '12px sans-serif';
      for (let y = y0 + 30; y < y0 + cell - 16; y += 16) { g.fillText(line(9), 20, y); g.fillRect(14, y + 4, 1134, 1) }
    }
    return toPng(cv);
  };
  // (b) 手機全頁截圖：頂部列、文字段落、色塊卡片、小圖示
  const fullPage = async () => {
    const cv = document.createElement('canvas'); cv.width = 1080; cv.height = 5000;
    const g = cv.getContext('2d'); g.fillStyle = '#f4f5f7'; g.fillRect(0, 0, 1080, 5000);
    g.fillStyle = '#2b6cb0'; g.fillRect(0, 0, 1080, 120);
    g.fillStyle = '#fff'; g.font = 'bold 40px sans-serif'; g.fillText('我的訂單', 40, 78);
    for (let i = 0, y = 150; y < 4900; i++, y += 250) {
      g.fillStyle = '#fff'; g.fillRect(30, y, 1020, 230);
      g.fillStyle = 'hsl(' + ((i * 47) % 360) + ',55%,60%)'; g.fillRect(50, y + 20, 190, 190);
      g.fillStyle = '#222'; g.font = '30px sans-serif'; g.fillText('商品 ' + (i + 1) + '　' + line(1).slice(0, 14), 270, y + 60);
      g.fillStyle = '#555'; g.font = '24px sans-serif'; g.fillText(line(2).slice(0, 34), 270, y + 105);
      g.font = '20px sans-serif'; g.fillText(line(2).slice(0, 40), 270, y + 145);
      g.fillStyle = '#e53e3e'; g.beginPath(); g.arc(990, y + 60, 18, 0, 6.3); g.fill();
      g.fillStyle = '#38a169'; g.fillRect(960, y + 150, 60, 36);
    }
    return toPng(cv);
  };
  const bytesOf = b64 => Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  const oldRule = async blob => {   // 舊規則：只看長邊 2048、品質 0.88，同一條 canvas → webp 路徑
    const bmp = await createImageBitmap(blob);
    const { w, h } = fitSize(bmp.width, bmp.height, 2048);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, h);
    const out = await new Promise(res => cv.toBlob(b => res(b), 'image/webp', 0.88));
    return { w, h, bytes: out.size };
  };
  const cases = [['設計稿長圖', await designSheet(), 1162, 3604], ['手機全頁截圖', await fullPage(), 1080, 5000]];
  const lines = [];
  for (const [label, blob, W, H] of cases) {
    const n = await imageFromBlob(blob, label + '.png');
    const bytes = bytesOf(n.data);
    const o = await oldRule(blob);
    lines.push(label + ' 新 ' + n.width + '×' + n.height + ' ' + bytes + ' B；舊 ' + o.w + '×' + o.h + ' ' + o.bytes + ' B');
    if (n.width !== W || n.height !== H) return { ok: false, why: label + '：新規則輸出應為 ' + W + '×' + H + '，實際 ' + n.width + '×' + n.height };
    if (bytes > MAX) return { ok: false, why: label + '：新規則檔案 ' + bytes + ' B 超過 1.5 MB（' + MAX + '）' };
    if (!(o.w < W)) return { ok: false, why: label + '：舊規則寬度 ' + o.w + ' 應比 ' + W + ' 窄，這支探測量不到差別' };
  }
  return { ok: true, why: lines.join('｜') };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

// 後備輪次（#2331）：模擬低階手機記憶體不夠——畫布總像素超過門檻就配不出來（getContext 回 null、toBlob 回 null，跟真實瀏覽器配不到記憶體時一樣）。
// 1162×3604 的長圖：第 1 輪（新規則 1162×3604 ≈ 4.19 MP）與第 2 輪（1000×3102 ≈ 3.10 MP）都超過門檻 2 MP 而失敗，
// 第 3 輪（舊規則長邊 2048 → 660×2048 ≈ 1.35 MP）成功。斷言：寄得出去、落在「長邊 2048 的舊規則那一級」（寬高 = fitSize(1162,3604,2048)）、
// 新規則那兩輪確實被試過也確實失敗（攔截器計數 ≥ 2，且看到過 1162×3604 這個尺寸），避免假綠。攔截在 finally 還原，並驗證還原後與原函式相同。
export const FALLBACK_PIXEL_LIMIT = 2_000_000

export const longPhotoFallbackSource = () => `(async () => {
  const LIMIT = ${FALLBACK_PIXEL_LIMIT};
  const proto = HTMLCanvasElement.prototype;
  const origGetContext = proto.getContext, origToBlob = proto.toBlob;
  const failedSizes = [];
  try {
  const { imageFromBlob } = await import('/lib/photo-canvas.mjs');
  const { fitSize } = await import('/lib/photo.mjs');
  // 先在攔截前造好 1162×3604 的長圖
  const src = document.createElement('canvas'); src.width = 1162; src.height = 3604;
  const g0 = src.getContext('2d'); g0.fillStyle = '#fff'; g0.fillRect(0, 0, 1162, 3604);
  g0.fillStyle = '#222'; g0.font = '14px sans-serif';
  for (let y = 20; y < 3604; y += 18) g0.fillText('Order ' + y + '  訂單編號 ' + (y * 7919 % 9973) + '  備註 設計稿', 20, y);
  const blob = await new Promise(res => src.toBlob(b => res(b), 'image/png'));
  // 攔截：超過門檻的畫布一律配不出來
  const tooBig = cv => cv.width * cv.height > LIMIT;
  proto.getContext = function (...a) {
    if (tooBig(this)) { failedSizes.push(this.width + '×' + this.height); return null }
    return origGetContext.apply(this, a);
  };
  proto.toBlob = function (cb, ...a) {
    if (tooBig(this)) { failedSizes.push(this.width + '×' + this.height); setTimeout(() => cb(null), 0); return }
    return origToBlob.call(this, cb, ...a);
  };
  let n;
  try { n = await imageFromBlob(blob, 'long.png') } catch (e) { return { ok: false, why: '8 MP 配不出來時沒有退到後備輪次，寄出失敗：' + (e && e.message || e) + '（失敗尺寸 ' + failedSizes.join('、') + '）' } }
  const old = fitSize(1162, 3604, 2048);
  const tier = [2048, 1600, 1200].find(L => { const f = fitSize(1162, 3604, L); return f.w === n.width && f.h === n.height }) || '?';
  const note = '落在長邊 ' + tier + ' 那一級，輸出 ' + n.width + '×' + n.height + '，失敗 ' + failedSizes.length + ' 次（' + failedSizes.join('、') + '）';
  if (!failedSizes.length || failedSizes.length < 2) return { ok: false, why: '新規則的輪次沒有被試到或沒有失敗（失敗 ' + failedSizes.length + ' 次），這支探測量不到後備：' + note };
  if (!failedSizes.includes('1162×3604')) return { ok: false, why: '第 1 輪（新規則 1162×3604）沒有被試過：' + note };
  if (n.width !== old.w || n.height !== old.h) return { ok: false, why: '應落在長邊 2048 那一級（舊規則 ' + old.w + '×' + old.h + '），實際 ' + note };
  if (!(n.data && n.data.length > 0)) return { ok: false, why: '輸出沒有圖資料：' + note };
  return { ok: true, why: note };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) }
  } finally {
    proto.getContext = origGetContext; proto.toBlob = origToBlob;
    if (proto.getContext !== origGetContext || proto.toBlob !== origToBlob) console.error('攔截沒有還原');
  }
})()`

export default {
  key: 'longPhoto',
  kind: p => (p.fallback ? '長圖寄出後備輪次檢查' : '長圖寄出檢查'),
  source: p => (p.fallback ? longPhotoFallbackSource() : longPhotoProbeSource()),
  scenarios: [
    { name: 'list-long-photo', page: 'list.html', width: 900, height: 640, state: { signedIn: true, bar: 'offline' }, ready: '#app.win .actionbar', probe: { longPhoto: true } },
    { name: 'list-long-photo-fallback', page: 'list.html', width: 900, height: 640, state: { signedIn: true, bar: 'offline' }, ready: '#app.win .actionbar', probe: { longPhoto: true, fallback: true } },
  ],
}
