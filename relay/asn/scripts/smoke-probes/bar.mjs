// 冒煙探測「大按鈕檢查」（probe.bar）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const barProbeSource = ({ bar, badge, taskItems, header, wake }) => `(async () => {
  const want = ${JSON.stringify(bar)}, wantWake = ${JSON.stringify(wake === true)};
  const wantBadge = ${JSON.stringify(badge ?? null)}, wantItems = ${JSON.stringify(taskItems ?? null)}, wantHeader = ${JSON.stringify(header ?? null)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let why = '';
  for (let i = 0; i < 60; i++) {
    const bars = [...document.querySelectorAll('.actionbar')].filter(b => b.offsetParent !== null);
    const btns = bars.length === 1 ? [...bars[0].querySelectorAll('.abtn')] : [];
    const off = b => b.getAttribute('aria-disabled') === 'true';
    const got = btns.map(b => [b.dataset.slot || '', b.querySelector('.ab-name')?.textContent.replace(/\\s*▾\\s*$/, '').trim() || '', off(b)]);
    why = bars.length !== 1 ? '看得到的功能列有 ' + bars.length + ' 條' : JSON.stringify(got) === JSON.stringify(want) ? '' : '按鈕不符：' + JSON.stringify(got);
    if (!why) {
      const bad = btns.find(b => off(b) && !b.title);
      if (btns.some(b => b.hasAttribute('disabled'))) why = '反灰不能用 disabled（滑鼠、Tab 讀不到原因）';
      else if (bad) why = bad.dataset.slot + ' 反灰卻沒有原因';
      else if (btns.some(b => off(b) && b.title.length > 20)) why = '反灰原因超過 20 字';
      else {
        // 反灰的選單鈕點了不能打開選單
        for (const b of btns.filter(b => off(b) && b.getAttribute('aria-haspopup'))) {
          b.click(); await sleep(150);
          if (b.getAttribute('aria-expanded') === 'true' || document.querySelector('.ab-menu')) return { ok: false, why: b.dataset.slot + ' 反灰卻點得開' };
        }
        // 工作項目（#539 之三）：徽章數字、header 拿掉件數、按下去的列表
        const tb = btns.find(b => b.dataset.slot === 'tasks');
        const badgeText = tb?.querySelector('.ab-badge')?.textContent.trim() ?? '';
        if (wantBadge !== null && badgeText !== wantBadge) return { ok: false, why: '工作項目徽章是「' + badgeText + '」，應為「' + wantBadge + '」' };
        if (wantHeader !== null) {
          const h = document.querySelector('.to-psm')?.textContent.trim() ?? '';
          if (h !== wantHeader) return { ok: false, why: 'header 個人訊息是「' + h + '」，應為「' + wantHeader + '」' };
        }
        // 第 2 格：喚醒時是喚醒圖示、點了開「喚醒」對話框，「管理」選單裡沒有喚醒；不是喚醒時是視窗圖示
        const wb = btns.find(b => b.dataset.slot === 'window');
        const wimg = wb?.querySelector('img')?.getAttribute('src') ?? '';
        if (wantWake) {
          if (wimg !== 'img/ab-wake.svg') return { ok: false, why: '喚醒的圖示是「' + wimg + '」' };
          const mg = btns.find(b => b.dataset.slot === 'manage');
          mg.click(); await sleep(200);
          const left = [...document.querySelectorAll('.ab-menu .mi-t')].map(e => e.textContent.trim()).filter(t => /喚醒/.test(t));
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await sleep(150);
          if (left.length) return { ok: false, why: '「管理」裡還有喚醒' };
          wb.click();
          let row = null;
          for (let j = 0; j < 30 && !row; j++) { await sleep(100); row = document.querySelector('.chatpane .typing.typing-op') }
          // #1800：喚醒沒有要使用者選的東西（auto），送出後只在提示列就地顯示進度，不開對話框
          if (document.querySelector('.dlg[role="dialog"]')) return { ok: false, why: '喚醒送出後不該有擋畫面的對話框' };
          if (!row) return { ok: false, why: '點了喚醒，提示列沒有出現進度' };
          const rt = row.textContent.replace(/\s+/g, ' ').trim();
          if (!/正在發送指令/.test(rt)) return { ok: false, why: '提示列的文字不是喚醒的進度：' + rt };
          } else if (wb && wimg !== 'img/ab-window.svg') return { ok: false, why: '第 2 格圖示是「' + wimg + '」' };
        if (wantItems) {
          tb.click();
          let items = [];
          for (let j = 0; j < 30; j++) { await sleep(100); items = [...document.querySelectorAll('.ab-tasks li')].map(e => e.querySelector('.ab-sub-text')?.textContent.trim() ?? e.textContent.trim()); if (JSON.stringify(items) === JSON.stringify(wantItems)) break }
          if (JSON.stringify(items) !== JSON.stringify(wantItems)) return { ok: false, why: '工作項目列表不符：' + JSON.stringify(items) };
        }
        return { ok: true, why: '' };
      }
    }
    await sleep(100);
  }
  return { ok: false, why };
})()`

export default {
  key: 'bar',
  kind: '大按鈕檢查',
  source: probe => barProbeSource(probe),
  // 喚醒送出後後台一直處理中，提示列的文字才固定是「正在發送指令…」（#1800）
  table: scenario => scenario.name === 'list-bar-fixed-offline'
    ? { relay_partner_op: { id: 'op-1' }, android_partner_op: { id: 'op-1' }, relay_partner_ops: { ops: [{ id: 'op-1', status: 'pending' }] }, android_partner_ops: { ops: [{ id: 'op-1', status: 'pending' }] } }
    : undefined,
}
