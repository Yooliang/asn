// 冒煙探測「設備列指紋圖示檢查」（probe.fpMark）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const fpMarkProbeSource = mode => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const real = req => { globalThis.__smokeInput(JSON.stringify(req)); return sleep(400) };
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const vis = e => e && e.getClientRects().length > 0;
  const phone = ${JSON.stringify(mode)} === 'phone';
  if (phone) {
    let btn = null;
    for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => vis(b) && b.textContent.includes('設備')) || null; if (!btn) await sleep(100) }
    if (!btn) return { ok: false, why: '找不到設定裡的「設備」' };
    await real({ click: at(btn) }); await sleep(300);
  }
  const rowSel = phone ? '.m-dv-row' : '.dv-row';
  let rows = [];
  for (let i = 0; i < 60; i++) { rows = [...document.querySelectorAll(rowSel)].filter(vis); if (rows.length >= 3) break; await sleep(100) }
  if (rows.length < 3) return { ok: false, why: '設備列不夠：' + rows.length };
  const row = name => rows.find(r => (r.querySelector(phone ? 'b' : '.dv-name')?.textContent ?? '').trim() === name);
  for (const r of rows) {
    const t = r.textContent;
    if (/已確認|未確認|已登入|未安裝|還沒收到/.test(t)) return { ok: false, why: '列上還有膠囊或狀態那一行：' + t.trim().slice(0, 60) };
    if (r.querySelector(phone ? '.m-dv-line' : '.dv-line')) return { ok: false, why: '列上還有狀態那一行' };
  }
  const expect = phone ? [['辦公室', 'confirmed', '已確認指紋', 'check'], ['工作機', 'unconfirmed', '尚未確認指紋', 'alert']] : [['小良的手機', 'remembered', '已記住指紋 ', ''], ['舊手機', 'unknown', '還沒記住指紋', 'alert']];
  const colors = new Set();
  for (const [name, cls, label, badge] of expect) {
    const r = row(name);
    if (!r) return { ok: false, why: '找不到「' + name + '」那一列' };
    const m = r.querySelector('.fpm');
    if (!m) return { ok: false, why: name + ' 沒有指紋圖示' };
    if (!m.classList.contains(cls)) return { ok: false, why: name + ' 的指紋圖示應該是 ' + cls };
    const al = m.getAttribute('aria-label') || '';
    if (!al.startsWith(label) || m.getAttribute('title') !== al) return { ok: false, why: name + ' 的說明不對：' + al };
    if (m.getBoundingClientRect().width < 16) return { ok: false, why: name + ' 的指紋圖示太小或沒畫出來' };
    const b = m.querySelector('.fpm-badge');
    if (!!badge !== !!b) return { ok: false, why: name + (badge ? ' 少了角落的記號（不能只靠顏色）' : ' 不該有角落的記號') };
    if (badge === 'alert' && b.querySelectorAll('path').length !== 2) return { ok: false, why: name + ' 的記號應該是「!」' };
    if (badge === 'check' && b.querySelectorAll('path').length !== 1) return { ok: false, why: name + ' 的記號應該是勾' };
    colors.add(getComputedStyle(m).color);
  }
  if (colors.size !== 2) return { ok: false, why: '兩種狀態的顏色要不同' };
  if (!phone) {
    const pc = row('辦公室');
    if (pc && pc.querySelector('.fpm')) return { ok: false, why: '電腦那一列不該有指紋圖示（電腦版只有手機有指紋）' };
    const al = row('小良的手機').querySelector('.fpm').getAttribute('aria-label');
    if (!/已記住指紋 [0-9a-f]{4} [0-9a-f]{4}$/.test(al)) return { ok: false, why: '電腦版的說明要帶 8 碼指紋：' + al };
  } else {
    // 長按出現說明
    const m = row('工作機').querySelector('.fpm');
    await real({ hold: [...at(m), 700] }); await sleep(500);   // 按住 700 毫秒才放開，等它放開
    const tip = m.querySelector('.fpm-tip');
    if (!tip || tip.textContent.trim() !== '尚未確認指紋') return { ok: false, why: '長按指紋圖示沒有出現說明' };
  }
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

export default {
  key: 'fpMark',
  kind: '設備列指紋圖示檢查',
  source: probe => fpMarkProbeSource(probe.fpMark),
}
