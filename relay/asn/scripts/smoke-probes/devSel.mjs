// 冒煙探測「手機設備列點選才展開檢查」（probe.devSel）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

// 手機設備頁（#1539）：每列平常不顯示按鈕，點一下那一列才展開它的「上移／下移／帳號／詳情」。全部用真觸控：
// 手指滑過列不會展開；點一下展開（只有那一列、有明顯底色）；展開的按鈕按得到（下移真的換了順序）；點別列換過去；再點同一列收起；拖拉把手不會展開
export const devSelProbeSource = () => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 400) };
  const tap = async el => { el.scrollIntoView({ block: 'center' }); await sleep(150); await real({ hold: [...at(el), 60] }) };
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => vis(b) && b.textContent.includes('設備')) || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到設定裡的「設備」' };
  await real({ click: at(btn) });
  const rows = () => [...document.querySelectorAll('.m-dv-row')].filter(vis);
  for (let i = 0; i < 60 && rows().length < 3; i++) await sleep(100);
  if (rows().length < 3) return { ok: false, why: '設備列少於 3 列' };
  const row = name => rows().find(r => (r.querySelector('.m-dv-rn b')?.textContent ?? '').trim() === name);
  const names = () => rows().map(r => (r.querySelector('.m-dv-rn b')?.textContent ?? '').trim());
  const opened = () => rows().filter(r => vis(r.querySelector('.m-dv-rowbtns')));
  const sel = () => rows().filter(r => r.classList.contains('sel'));
  if (opened().length || sel().length) return { ok: false, why: '一開始就有列展開了按鈕' };
  await real({ touch: true }, 100);
  // 一、手指滑過列（捲動）：不能展開
  const office = row('辦公室');
  office.scrollIntoView({ block: 'center' }); await sleep(150);
  // 捲動的是設備清單外層那個可以捲的容器；先記下位置，滑完要真的有捲動，不然這一步等於沒測（觸控沒送出也會是綠的）
  let scroller = office.parentElement;
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
  if (!scroller) return { ok: false, why: '設備清單沒有可以捲動的外層，測不到「捲動不會展開」（情境的高度要再小一點）' };
  const top0 = scroller.scrollTop, rowTop0 = office.getBoundingClientRect().top;
  { const c = at(office.querySelector('.m-dv-go')); await real({ gesture: [c[0], c[1], 0, -90] }, 600) }
  if (!(scroller.scrollTop > top0 + 4) || !(office.getBoundingClientRect().top < rowTop0 - 4)) return { ok: false, why: '手指往上滑沒有真的捲動：scrollTop ' + top0 + ' → ' + scroller.scrollTop };
  if (opened().length || sel().length) return { ok: false, why: '手指滑過列（捲動）就展開了按鈕' };
  // 二、點一下：只有那一列展開，而且有明顯底色
  await tap(row('辦公室').querySelector('.m-dv-go'));
  if (opened().length !== 1 || opened()[0] !== row('辦公室')) return { ok: false, why: '點一下辦公室沒有（只）展開它的按鈕：' + opened().map(r => r.querySelector('b').textContent).join('、') };
  const bgSel = getComputedStyle(row('辦公室')).backgroundColor, bgOther = getComputedStyle(row('工作機')).backgroundColor;
  if (bgSel === bgOther) return { ok: false, why: '選中的那一列沒有不同的底色：' + bgSel };
  if (row('辦公室').querySelector('.m-dv-go').getAttribute('aria-expanded') !== 'true') return { ok: false, why: '選中的那一列 aria-expanded 不是 true' };
  const labels = [...row('辦公室').querySelectorAll('.m-dv-rowbtns button')].filter(vis).map(b => b.textContent.trim());
  if (labels.join('、') !== '上移、下移、帳號、詳情') return { ok: false, why: '展開的按鈕不是上移、下移、帳號、詳情：' + labels.join('、') };
  // 三、展開的按鈕按得到：按「下移」，辦公室換到工作機後面，而且還是選中的
  const before = names().join('、');
  await tap([...row('辦公室').querySelectorAll('.m-dv-rowbtns button')].find(b => b.textContent.trim() === '下移'));
  if (names().join('、') === before) return { ok: false, why: '按「下移」順序沒變：' + before };
  if (names().indexOf('辦公室') < names().indexOf('工作機')) return { ok: false, why: '按「下移」後辦公室應該在工作機後面：' + names().join('、') };
  if (opened().length !== 1 || opened()[0] !== row('辦公室')) return { ok: false, why: '按了「下移」之後展開的列不對' };
  // 四、點別列：換成展開那一列
  await tap(row('工作機').querySelector('.m-dv-go'));
  if (opened().length !== 1 || opened()[0] !== row('工作機')) return { ok: false, why: '點別列沒有換過去：' + opened().map(r => r.querySelector('b').textContent).join('、') };
  // 五、再點同一列：收起
  await tap(row('工作機').querySelector('.m-dv-go'));
  if (opened().length || sel().length) return { ok: false, why: '再點同一列沒有收起' };
  // 六、拖拉把手：不會展開
  const grip = row('工作機').querySelector('.m-dv-grip');
  if (grip) { const c = at(grip); await real({ gesture: [c[0], c[1], 0, 60] }, 600) }
  if (opened().length || sel().length) return { ok: false, why: '拖拉把手就展開了按鈕' };
  // 七、按展開的「詳情」進去再返回：回到清單時是收起的
  await tap(row('工作機').querySelector('.m-dv-go'));
  await tap([...row('工作機').querySelectorAll('.m-dv-rowbtns button')].find(b => b.textContent.trim() === '詳情'));
  let back = null;
  for (let i = 0; i < 30 && !back; i++) { back = [...document.querySelectorAll('.m-icon-btn[aria-label="返回"]')].find(vis) || null; if (!back) await sleep(100) }
  if (!back || rows().length) return { ok: false, why: '按「詳情」沒有進到那台的頁面' };
  await tap(back);
  for (let i = 0; i < 30 && rows().length < 3; i++) await sleep(100);
  if (opened().length || sel().length) return { ok: false, why: '從詳情返回清單時還是展開的' };
  // 留一列展開給截圖看
  await tap(row('工作機').querySelector('.m-dv-go'));
  await real({ touch: false }, 100);
  if (opened().length !== 1) return { ok: false, why: '最後點一下沒有展開' };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

export default {
  key: 'devSel',
  kind: '手機設備列點選才展開檢查',
  source: () => devSelProbeSource(),
}
