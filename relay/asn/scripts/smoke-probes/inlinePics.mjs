// 冒煙探測「對話裡直接顯示圖片」（probe.inlinePics，#1911）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// scene＝'conv'：直圖、橫圖（剩 3 天）、連續四張（兩欄方格）；scene＝'states'：下載中、沒載入成功、太大、過期；scene＝'bigclick'：按「下載照片」才下載
// phone＝true 時另外檢查有「分享」、框最大 250×300；電腦不能有「分享」、框最大 280×320
// 假後台：每張圖的大圖用 svg；下載中的那張永遠不回、失敗的那張回錯誤（smoke-lib 的 relay_attachment_fetch 依 id 對照，__hang／__fail）

const ID = n => `00000000-0000-4000-8000-0000000019${String(n).padStart(2, '0')}`
const THUMB = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='
const svg = (w, h, a, b) => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.7}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.12}" fill="#fff3d0"/><path d="M0 ${h} L${w * 0.35} ${h * 0.55} L${w * 0.6} ${h * 0.8} L${w * 0.8} ${h * 0.6} L${w} ${h * 0.85} V${h}Z" fill="rgba(20,30,50,.55)"/></svg>`)
const att = (n, name, w, h, o = {}) => ({ id: ID(n), kind: 'image', name, mime: 'image/webp', bytes: 300_000, width: w, height: h, thumb: THUMB, expires_at: '2099-01-01T00:00:00Z', ...o })
const them = (n, text, attachments) => ({ id: `00000000-0000-4000-8000-0000000018${String(n).padStart(2, '0')}`, dir: 'them', body: text, created_at: `2026-11-25T01:${String(10 + n).padStart(2, '0')}:00Z`, attachments })

const BIG_BYTES = Math.round(3.4 * 1024 * 1024)   // 附件大小要是整數，不然會被當成「大小不明」
const THREE_DAYS = () => new Date(Date.now() + 2.5 * 86400_000).toISOString()   // 兩天半後到期：進位成「剩 3 天」
const CONV = () => [
  them(1, '直的圖：', [att(1, '森林.webp', 900, 1200)]),
  them(2, '橫的圖（快到期才會多一行提醒）：', [att(2, '湖.webp', 1600, 1000, { expires_at: THREE_DAYS() })]),
  { id: '00000000-0000-4000-8000-000000001803', dir: 'me', body: '收到，再來一組', created_at: '2026-11-25T01:13:00Z', delivered_at: '2026-11-25T01:13:01Z', acked_at: '2026-11-25T01:13:02Z' },
  them(4, '連續四張：', [att(3, '城市.webp', 1200, 1200), att(4, '花.webp', 1200, 1200), att(5, '湖二.webp', 1600, 1000), att(6, '森林二.webp', 900, 1200)]),
]
const STATES = () => [
  them(1, '下載中：', [att(11, '下載中.webp', 1600, 1000)]),
  them(2, '失敗（可重試）：', [att(12, '失敗.webp', 900, 1200)]),
  them(3, '太大不自動下載：', [att(13, '太大.webp', 1200, 1200, { bytes: BIG_BYTES })]),
  them(4, '已過期：', [att(14, '過期.webp', 1600, 1000, { expired: true })]),
]
const BIGCLICK = () => [them(1, '太大不自動下載：', [att(13, '太大.webp', 1200, 1200, { bytes: BIG_BYTES })])]
const FULL = {
  [ID(1)]: svg(900, 1200, '#4f7a5a', '#a8c8a0'), [ID(2)]: svg(1600, 1000, '#5c8fc4', '#d4e6f5'), [ID(3)]: svg(1200, 1200, '#6b6f8f', '#c4b8d8'),
  [ID(4)]: svg(1200, 1200, '#c46b8a', '#f5d0dc'), [ID(5)]: svg(1600, 1000, '#4a9a8f', '#c4ece4'), [ID(6)]: svg(900, 1200, '#8a7a4a', '#e8dca8'),
  [ID(13)]: svg(1200, 1200, '#7a5ca8', '#d8c8f0'),
}
const FETCH = () => ({
  by: 'id',
  values: { ...Object.fromEntries(Object.entries(FULL).map(([id, u]) => [id, { name: 'x.webp', mime: 'image/svg+xml', data_url: u }])), [ID(11)]: { __hang: true }, [ID(12)]: { __fail: '網路不穩' } },
  fallback: { name: 'x.webp', mime: 'image/svg+xml', data_url: svg(800, 600, '#888', '#ccc') },
})

export const inlinePicsProbeSource = ({ scene, phone }) => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const PHONE = ${JSON.stringify(!!phone)}, SCENE = ${JSON.stringify(scene)};
  const MAXW = PHONE ? 250 : 280, MAXH = PHONE ? 300 : 320;
  const q = sel => [...document.querySelectorAll('.chatpane ' + sel)].filter(e => e.getClientRects().length);
  const wait = async (fn, n = 80) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return fn() };
  const frame = name => q('.att-frame').find(e => (e.getAttribute('title') || '').startsWith(name));
  const acts = f => { const box = f && f.closest('.att'); return box ? box.querySelector('.att-acts') : null };
  const labels = a => [...a.querySelectorAll('button')].map(b => b.textContent.trim());
  const within = (f, w, h) => { const r = f.getBoundingClientRect(); return r.width <= w + 1.5 && r.height <= h + 1.5 };
  if (SCENE === 'conv') {
    const ok = await wait(() => q('.att-frame[data-state="ready"]').length >= 6);
    if (!ok) return { ok: false, why: '六張圖沒有都顯示出大圖：' + q('.att-frame').map(e => e.dataset.state).join(',') };
    for (const n of ['森林.webp', '湖.webp']) {
      const f = frame(n); if (!f) return { ok: false, why: '找不到 ' + n };
      if (!within(f, MAXW, MAXH)) return { ok: false, why: n + ' 超過最大尺寸：' + f.getBoundingClientRect().width + '×' + f.getBoundingClientRect().height };
      const a = acts(f); if (!a) return { ok: false, why: n + ' 下方沒有動作列' };
      const want = PHONE ? '儲存|另存新檔|分享' : '儲存|另存新檔';
      if (labels(a).join('|') !== want) return { ok: false, why: n + ' 的動作列是「' + labels(a).join('|') + '」，應該是「' + want + '」' };
      if (a.classList.contains('off')) return { ok: false, why: n + ' 大圖已經在了，動作列不該反灰' };
    }
    const tall = frame('森林.webp').getBoundingClientRect(), wide = frame('湖.webp').getBoundingClientRect();
    if (!(tall.height > tall.width && wide.width > wide.height)) return { ok: false, why: '直圖、橫圖沒有保持比例' };
    if (!/剩 3 天可下載/.test(document.querySelector('.chatpane').textContent)) return { ok: false, why: '快到期的橫圖沒有「剩 3 天可下載」' };
    if ((document.querySelector('.chatpane').textContent.match(/天可下載/g) || []).length !== 1) return { ok: false, why: '只有快到期的那張才該提醒，卻出現不只一次' };
    const cells = ['城市.webp', '花.webp', '湖二.webp', '森林二.webp'].map(frame);
    if (cells.some(c => !c)) return { ok: false, why: '方格裡少了圖' };
    const side = PHONE ? 123 : 138, rs = cells.map(c => c.getBoundingClientRect());
    if (rs.some(r => Math.abs(r.width - side) > 1.5 || Math.abs(r.height - side) > 1.5)) return { ok: false, why: '方格每格應該是 ' + side + ' 見方：' + rs.map(r => Math.round(r.width) + '×' + Math.round(r.height)).join(' ') };
    if (new Set(rs.map(r => Math.round(r.left))).size !== 2 || new Set(rs.map(r => Math.round(r.top))).size !== 2) return { ok: false, why: '四張沒有排成兩欄兩列' };
    if (cells.some(c => c.closest('.att'))) return { ok: false, why: '方格裡的圖不該各自帶動作列（儲存走看大圖）' };
    return { ok: true, why: '' };
  }
  if (SCENE === 'states') {
    const fl = await wait(() => frame('失敗.webp') && frame('失敗.webp').dataset.state === 'failed' && frame('失敗.webp'));
    if (!fl) return { ok: false, why: '失敗的圖沒有進入失敗狀態：' + (frame('失敗.webp') || {}).dataset.state };
    if (!/沒載入成功/.test(fl.textContent) || !fl.querySelector('.att-pill') || fl.querySelector('.att-pill').textContent.trim() !== '重試') return { ok: false, why: '失敗要寫「沒載入成功」並有「重試」：' + fl.textContent };
    if (acts(fl)) return { ok: false, why: '失敗時不該有動作列' };
    if (!fl.querySelector('img')) return { ok: false, why: '失敗時要保留縮圖' };
    if (document.querySelector('[role="dialog"], .asn-dialog')) return { ok: false, why: '失敗不該跳出視窗' };
    { const f0 = frame('下載中.webp'); if (f0) f0.scrollIntoView({ block: 'center' }) }
    const ld = await wait(() => frame('下載中.webp') && frame('下載中.webp').dataset.state === 'loading' && frame('下載中.webp')) || frame('下載中.webp');
    if (!ld || ld.dataset.state !== 'loading') return { ok: false, why: '下載中的圖狀態不對：' + (ld && ld.dataset.state) };
    if (!ld.querySelector('.att-spin')) return { ok: false, why: '下載中要有轉圈' };
    if (!ld.querySelector('img')) return { ok: false, why: '下載中要有模糊的縮圖' };
    const la = acts(ld); if (!la || !la.classList.contains('off')) return { ok: false, why: '下載中動作列要有、而且反灰' };
    const bg = frame('太大.webp');
    if (!bg || bg.dataset.state !== 'big') return { ok: false, why: '太大的圖狀態不對：' + (bg && bg.dataset.state) };
    const pill = bg.querySelector('.att-pill');
    if (!pill || !/^下載照片　3\\.4 MB$/.test(pill.textContent.trim())) return { ok: false, why: '太大要有「下載照片　3.4 MB」：' + (pill && pill.textContent) };
    if (acts(bg)) return { ok: false, why: '太大時不該有動作列' };
    const ex = frame('過期.webp');
    if (!ex || ex.dataset.state !== 'expired') return { ok: false, why: '過期的圖狀態不對：' + (ex && ex.dataset.state) };
    if (!/照片已過期/.test(ex.textContent) || !/超過 30 天保存期限，已刪除/.test(ex.textContent)) return { ok: false, why: '過期要寫兩行說明：' + ex.textContent };
    if (ex.tagName === 'BUTTON' || ex.querySelector('button') || acts(ex)) return { ok: false, why: '過期不給任何動作' };
    if (getComputedStyle(ex).borderTopStyle !== 'dashed') return { ok: false, why: '過期要是虛線框' };
    return { ok: true, why: '' };
  }
  if (SCENE === 'bigclick') {
    const bg = await wait(() => frame('太大.webp'));
    if (!bg || bg.dataset.state !== 'big') return { ok: false, why: '一開始應該是太大狀態：' + (bg && bg.dataset.state) };
    await sleep(600);
    if (bg.dataset.state !== 'big') return { ok: false, why: '太大的圖不能自己下載' };
    if ((globalThis.__smokeCalls || []).some(c => c[0] === 'relay_attachment_fetch')) return { ok: false, why: '還沒按就跟 Rust 要了大圖' };
    bg.querySelector('.att-pill').click();
    const done = await wait(() => { const f = frame('太大.webp'); return f && f.dataset.state === 'ready' && f });
    if (!done) return { ok: false, why: '按了「下載照片」沒有顯示出大圖：' + (frame('太大.webp') || {}).dataset.state };
    if (!acts(done)) return { ok: false, why: '下載完要出現動作列' };
    return { ok: true, why: '' };
  }
  return { ok: false, why: '不認得的 scene：' + SCENE };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const skins = [['', 'aero'], ['modern', 'modern'], ['line', 'line']]
const sc = (name, page, scene, skin, extra = {}) => ({
  name, page, state: { signedIn: true, [page === 'm.html' ? 'mbar' : 'bar']: 'offline', inlinePics: scene, ...(skin ? { skin } : {}) },
  ready: page === 'm.html' ? '#app.m .m-chat .chatpane' : '#app.win .actionbar', probe: { inlinePics: { scene, phone: page === 'm.html' } }, ...extra,
})

export default {
  key: 'inlinePics',
  kind: '對話裡直接顯示圖片檢查',
  source: p => inlinePicsProbeSource(p.inlinePics),
  scenarios: [
    ...skins.flatMap(([skin, label]) => ['conv', 'states'].map(scene => ({ ...sc(`list-inline-pics-${scene}-${label}`, 'list.html', scene, skin), width: 900, height: scene === 'conv' ? 1500 : 1350, shot: `list-inline-pics-${scene}-${label}.png` }))),
    ...[['', 'aero'], ['modern', 'modern'], ['line', 'line']].slice(1).flatMap(([skin, label]) => ['conv', 'states'].map(scene => ({ ...sc(`m-inline-pics-${scene}-${label}`, 'm.html', scene, skin), height: scene === 'conv' ? 1500 : 1150, shot: `m-inline-pics-${scene}-${label}.png` }))),
    { ...sc('list-inline-pics-bigclick', 'list.html', 'bigclick', ''), width: 900, height: 640 },
  ],
  table: scenario => {
    const s = scenario.state.inlinePics
    if (!s) return undefined
    return { relay_chat_history: { messages: s === 'conv' ? CONV() : s === 'states' ? STATES() : BIGCLICK() }, relay_attachment_fetch: FETCH() }
  },
}
