// 冒煙探測「現代外觀檢查」（probe.skinCheck）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
import { lineProbeSource } from '../smoke-line.mjs'

export const skinProbeSource = (probe = {}) => probe.line ? lineProbeSource(probe.line) : `(async () => {
  const KEYS = ${JSON.stringify(probe.keys === true)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 40 && document.documentElement.dataset.skin !== 'modern'; i++) await sleep(100);
  if (document.documentElement.dataset.skin !== 'modern') return { ok: false, why: '存檔選了現代，畫面卻是 ' + (document.documentElement.dataset.skin || '沒有設定') };
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase();
  if (accent !== '#2f7a70') return { ok: false, why: '現代的主色沒有套上：' + accent };
  const on = document.querySelector('.top-tabs .ttab.on, .m-tabs button.on');
  if (on && getComputedStyle(on).color !== 'rgb(47, 122, 112)') return { ok: false, why: '選中的分頁不是主色：' + getComputedStyle(on).color };
  // 危險動作（忘記這台、移除帳號、登出、退出群組…）的紅色在現代底下還要在：放幾顆同樣 class 的按鈕量顏色
  const host = document.createElement('div'); host.className = 'logout-set'; document.body.appendChild(host);
  const reds = [];
  for (const cls of ['aero-btn danger', 'aero-btn dv-danger', 'gs-btn danger', 'm-btn m-danger', 'm-btn m-dv-danger']) { const b = document.createElement('button'); b.className = cls; b.textContent = '移除'; host.appendChild(b); reds.push([cls, b]) }
  const redOf = b => { const c = getComputedStyle(b); return cls => (cls === 'm-btn m-dv-danger' ? c.backgroundColor : c.color) };
  const bad = reds.filter(([cls, b]) => redOf(b)(cls) !== 'rgb(179, 38, 30)').map(([cls, b]) => cls + '＝' + redOf(b)(cls));
  host.remove();
  if (bad.length) return { ok: false, why: '危險按鈕在現代底下不是紅色：' + bad.join('、') };
  // #1421 A：畫面上有的元件才量（各情境畫面不同）
  for (let i = 0; i < 20 && document.querySelector('.msgs') && !document.querySelector('.msg .m-body.tone-them, .msg .m-body.tone-me'); i++) await sleep(100);
  const css = (sel, prop, pseudo) => { const el = document.querySelector(sel); return el ? getComputedStyle(el, pseudo).getPropertyValue(prop).trim() : null };
  const checks = [
    ['.msg .m-body.tone-them', 'border-top-left-radius', '18px', '對方訊息卡片的圓角'],
    ['.msg .m-body.tone-me', 'border-top-right-radius', '18px', '自己訊息卡片的圓角'],
    ['.dp', 'border-top-left-radius', '50%', '頭像要是圓的'],
    ['.m-chat .compose-main', 'border-top-width', '1px', '手機輸入框的邊框（mobile.css 的 border:0 不能蓋掉）'],
  ];
  for (const [sel, prop, want, label] of checks) { const v = css(sel, prop); if (v !== null && v !== want) return { ok: false, why: label + '：' + v } }
  const dot = document.querySelector('.dp:not(.room-av)');
  if (dot && getComputedStyle(dot, '::before').content === 'none') return { ok: false, why: '頭像右下沒有狀態點' };
  // 忙碌／離線的標題列、離線的收件人列：要有自己的底色，不能被現代的一般底色（#f6f5f2／白）蓋掉
  const plainBg = ['rgb(246, 245, 242)', 'rgb(255, 255, 255)'];
  for (const [sel, label] of [['.m-chathead.is-busy', '手機標題列忙碌變色'], ['.m-chathead.is-offline', '手機標題列離線變色'], ['.conv-main .to-line.is-offline', '電腦收件人列離線灰底']]) {
    const v = css(sel, 'background-color'); if (v !== null && plainBg.includes(v)) return { ok: false, why: label + '被現代底色蓋掉：' + v }
  }
  // 手機對話頂端（#1421 B 之三）：左返回、中間名牌、右看終端（36px 圓鈕）；原本的頭像、名字、「⋯」收起；下方工具列的終端切換收起
  const ph = document.querySelector('.m-plate-head');
  if (ph) {
    const vis = e => e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
    const plate = ph.querySelector('.m-plate');
    if (!vis(plate)) return { ok: false, why: '現代的對話頂端沒有名牌' };
    for (const sel of ['.m-pic', '.m-head-tx', '.m-head-more']) if (vis(ph.querySelector(':scope > ' + sel))) return { ok: false, why: '現代的對話頂端還留著 ' + sel };
    const hr = ph.getBoundingClientRect(), pr = plate.getBoundingClientRect();
    if (Math.abs((pr.left + pr.right) / 2 - (hr.left + hr.right) / 2) > 4) return { ok: false, why: '名牌沒有置中' };
    { const o = plate.style.width; plate.style.width = 'max-content'; const nat = plate.getBoundingClientRect().width; plate.style.width = o;
      console.info('[center-m-1on1]', JSON.stringify({ diff: (pr.left + pr.right) / 2 - (hr.left + hr.right) / 2, width: pr.width, natural: nat }));
      if (pr.width - nat > 2) return { ok: false, why: '名牌被撐寬：寬 ' + pr.width + '、內容需要 ' + nat }; }
    const back = ph.querySelector('.m-back');   // #1438 起對話分頁沒有返回鈕（直接是那一則）；有的話才量
    if (back && Math.round(back.getBoundingClientRect().width) !== 36) return { ok: false, why: '返回鈕不是 36px：' + back.getBoundingClientRect().width };
    const term = ph.querySelector('.m-head-term');
    if (term) {
      if (Math.round(term.getBoundingClientRect().width) !== 36) return { ok: false, why: '看終端鈕不是 36px' };
      if (vis(document.querySelector('.m-chat .m-term-switch'))) return { ok: false, why: '下方工具列的終端切換應該收起（搬到頂端了）' };
      term.click(); await sleep(400);
      if (!term.classList.contains('on')) return { ok: false, why: '點頂端的看終端沒有切到終端' };
      term.click(); await sleep(300);
    }
    const head = ph.closest('.m-chathead');
    if (head.classList.contains('is-offline') && !plate.classList.contains('is-offline') && !plate.closest('.is-room')) return { ok: false, why: '離線時名牌沒有跟著變灰' };
  }
  // 廣告框（#1421）：現代下是白底細灰框圓角卡片，不留 Aero 的藍框藍底、漸層彩球、斜緞帶
  const adw = document.querySelector('.ad-wrap');
  if (adw) {
    const w = getComputedStyle(adw);
    if (w.backgroundColor !== 'rgb(255, 255, 255)' || w.borderTopColor === 'rgb(155, 184, 214)' || w.borderTopLeftRadius !== '14px') return { ok: false, why: '廣告框外層還是 Aero：' + w.backgroundColor + ' ' + w.borderTopColor + ' ' + w.borderTopLeftRadius };
    const ad = adw.querySelector('.ad:not([style*="display: none"])');
    if (ad && getComputedStyle(ad).backgroundImage !== 'none') return { ok: false, why: '廣告底色還是漸層' };
    const ball = adw.querySelector('.ad-art i');
    if (ball && getComputedStyle(ball).backgroundImage !== 'none') return { ok: false, why: '廣告的彩球還是漸層' };
    const tag = adw.querySelector('.ad-new');
    if (tag && getComputedStyle(tag).transform !== 'none') return { ok: false, why: '廣告的緞帶還是斜的' };
  }
  // #1421 B2：輸入框是單列膠囊（一行 52px／手機 50px、細邊、圓角）、送出鈕 40px 實心主色圓且名字還在、「＋」開得起上方工具選單、看不見的舊工具列不佔位
  const cm = document.querySelector('.compose-main');
  if (cm) {
    const mobile = !!document.querySelector('.m-chat'), cs = getComputedStyle(cm), box = cm.getBoundingClientRect();
    const wantH = mobile ? 50 : 52;
    if (Math.abs(box.height - wantH) > 1.5) return { ok: false, why: '輸入框膠囊一行的高度不對：' + box.height + '（要 ' + wantH + '）' };
    if (cs.borderTopLeftRadius !== (mobile ? '25px' : '26px') || cs.borderTopColor !== 'rgb(230, 228, 223)') return { ok: false, why: '輸入框膠囊的圓角或邊線不對：' + cs.borderTopLeftRadius + ' ' + cs.borderTopColor };
    const sb = cm.querySelector('.composer .aero-btn[type=submit]'), sbc = sb && getComputedStyle(sb), sbr = sb && sb.getBoundingClientRect();
    if (!sb || Math.round(sbr.width) !== 40 || Math.round(sbr.height) !== 40 || sbc.backgroundColor !== 'rgb(47, 122, 112)' || sbc.borderTopLeftRadius !== '50%') return { ok: false, why: '送出鈕不是 40px 實心主色圓' };
    if (!sb.getAttribute('aria-label') || sb.getAttribute('aria-label') !== sb.textContent.trim()) return { ok: false, why: '送出鈕的名字（aria-label）要等於原本的字：' + sb.getAttribute('aria-label') + ' / ' + sb.textContent.trim() };
    const plus = cm.querySelector('.mc-plus'), tb = cm.querySelector(':scope > .toolbar');
    if (!plus || getComputedStyle(plus).display === 'none') return { ok: false, why: '輸入框左邊沒有「＋」' };
    if (tb && getComputedStyle(tb).display !== 'none') return { ok: false, why: '工具列平常應該收起來' };
    plus.click(); await sleep(150);
    const open = tb && getComputedStyle(tb).display !== 'none' && plus.getAttribute('aria-expanded') === 'true' && (vis => vis.length >= 3 && vis.every(t => t.getBoundingClientRect().height > 20))([...tb.querySelectorAll('.tool')].filter(t => getComputedStyle(t).display !== 'none'));
    plus.click(); await sleep(100);
    if (!open) return { ok: false, why: '按「＋」沒有展開工具選單' };
    // 點外面要收起來：開著選單，在膠囊外（對話區）按一下
    plus.click(); await sleep(100);
    if (!(tb && getComputedStyle(tb).display !== 'none')) return { ok: false, why: '「＋」沒有再開起來' };
    (document.querySelector('.msgs') || document.body).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await sleep(100);
    if (tb && getComputedStyle(tb).display !== 'none') return { ok: false, why: '點膠囊外面，工具選單沒有收起來' };
    if (KEYS) {
      // 鍵盤：Shift+Enter 不送出也不攔（瀏覽器自己換行）；電腦 Enter 送出並清空輸入框、手機 Enter 是換行（不送出、不攔）
      const ta = cm.querySelector('.composer textarea');
      const sent = () => (globalThis.__smokeCalls || []).filter(c => c[0] === 'relay_send').length;
      const press = (shift) => !ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey: shift, bubbles: true, cancelable: true }));
      ta.focus(); ta.value = '第一行'; ta.dispatchEvent(new Event('input', { bubbles: true })); await sleep(80);
      const n0 = sent();
      if (press(true) || ta.value !== '第一行' || sent() !== n0) return { ok: false, why: 'Shift+Enter 應該只換行（不攔、不送出）' };
      const prevented = press(false); await sleep(250);
      if (mobile) { if (prevented || ta.value !== '第一行' || sent() !== n0) return { ok: false, why: '手機 Enter 應該是換行（不攔、不送出）' }; }
      else if (!prevented || ta.value !== '' || sent() !== n0 + 1) return { ok: false, why: '電腦 Enter 沒有送出：輸入框＝「' + ta.value + '」、送出次數 ' + (sent() - n0) };
      ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  await sleep(400);
  // #1461 線條圖示：現代外觀看得到線條圖示；輸入框的「＋」打開後，工具列每一顆只看到線條、看不到原本的彩色圖
  const hiddenLic = [...document.querySelectorAll('svg.lic')].find(s => s.parentElement && s.parentElement.offsetParent !== null && getComputedStyle(s).display === 'none');
  if (hiddenLic) return { ok: false, why: '現代外觀的線條圖示被藏起來了：' + hiddenLic.dataset.icon };
  const plus = document.querySelector('.mc-plus');
  if (plus && plus.offsetParent !== null) {
    if (!plus.querySelector('svg.lic')) return { ok: false, why: '輸入框的「＋」沒有用線條圖示' };
    plus.click(); await sleep(250);
    for (const b of document.querySelectorAll('.toolbar .tool')) {
      if (b.offsetParent === null) continue;
      const name = b.getAttribute('aria-label') || '';
      if ([...b.querySelectorAll(':scope > svg:not(.lic), :scope > img')].some(x => getComputedStyle(x).display !== 'none')) return { ok: false, why: '工具列「' + name + '」還看得到原本的彩色圖' };
      if (!b.querySelector(':scope > svg.lic')) return { ok: false, why: '工具列「' + name + '」沒有線條圖示' };
    }
    plus.click(); await sleep(150);
  }
  if (document.documentElement.scrollWidth > innerWidth + 1) return { ok: false, why: '出現橫向捲動' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'skinCheck',
  kind: '現代外觀檢查',
  source: probe => skinProbeSource(probe),
}
