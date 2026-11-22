// 冒煙探測「帳號卡設備列切換結果原位顯示」（probe.rswitch，#2111 ③、#2110）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 用假後台走一次成功與失敗：按那一列的「切換」→ 鈕變「切換中…」→ 結果句出現在「那一列正下方」（成功綠、失敗紅），沒有跳框；
// 成功時卡片頂端出現「使用中」、那一列的鈕變「使用中」。不放截圖（不進 ui-shots-diff）。

export const rswitchProbeSource = ({ rswitch, mode, mail, label, open = '' }) => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const mobile = ${JSON.stringify(rswitch)} === 'mobile', mode = ${JSON.stringify(mode)}, mail = ${JSON.stringify(mail)}, label = ${JSON.stringify(label)}, open = ${JSON.stringify(open)};
  const S = mobile
    ? { card: '.m-dv-my .m-dv-acct', mail: '.m-dv-mail', row: '.m-dv-devrow', btn: '.m-dv-dev', res: '.m-dv-devres', cur: '.m-dv-cur' }
    : { card: '.dv-my .dv-acct', mail: '.dv-mail', row: '.dv-devrow', btn: '.dv-devbtn', res: '.dv-devres', cur: '.dv-cur' };
  if (open) {
    let b = null;
    for (let i = 0; i < 60 && !b; i++) { b = [...document.querySelectorAll('.m-row-btn')].find(x => x.textContent.includes(open)) || null; if (!b) await sleep(100) }
    if (!b) return { ok: false, why: '找不到「' + open + '」' };
    b.click();
  }
  const cardOf = () => [...document.querySelectorAll(S.card)].filter(vis).find(c => (c.querySelector(S.mail)?.textContent ?? '').includes(mail));
  let btn = null;
  for (let i = 0; i < 80 && !btn; i++) { btn = [...(cardOf()?.querySelectorAll(S.btn + (S.btn === '.dv-devbtn' ? ':not(.st-current):not(.st-busy):not(.st-blocked)' : '.switch')) ?? [])].find(vis) || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到 ' + mail + ' 那張卡上可按的「切換」鈕' };
  const card = cardOf(), row = btn.closest(S.row), name = (row.querySelector(mobile ? '.m-dv-devn' : '.dv-devn')?.childNodes[0]?.textContent ?? '').trim();
  const hadCur = !!card.querySelector(S.cur);
  if (!mobile && hadCur) return { ok: false, why: '按之前這張卡頂端就有「使用中」，測不出同步' };   // 手機這張卡的帳號本來就在手機自己那一列用著，頂端本來就有
  const invoke = globalThis.__TAURI__.core.invoke;
  if (mode === 'ok') {
    // 假後台：切換成功後，帳號列表跟著變（帳號在那一台變成使用中）。換掉回應要等按下去之後，之前的畫面用原本的
    if (mobile) {
      const roster = await invoke('android_acct_roster');
      roster.accounts = roster.accounts.map(a => a.vendor !== 'claude' ? a : ({ ...a, nodes: [...(a.nodes ?? []).filter(n => n.node !== 'Q').map(n => a.account === mail ? n : n), { node: 'Q', current: a.account === mail, reported_at: roster.now }] }));
      const q = await invoke('android_acct_list', { node: 'Q' });
      globalThis.__smokeOverrideLater = { android_acct_roster: roster, android_acct_list: { ...q, accounts: q.accounts.map(a => ({ ...a, current: a.email === mail })) } };
    } else {
      const list = await invoke('claude_accounts_list');
      globalThis.__smokeOverrideLater = { claude_accounts_list: list.map(a => ({ ...a, current: a.email === mail })) };
    }
  }
  const seen = new Set();
  seen.add(btn.textContent.trim());
  const mo = new MutationObserver(() => seen.add(btn.textContent.trim()));
  mo.observe(row, { subtree: true, childList: true, characterData: true, attributes: true });
  btn.click();
  if (globalThis.__smokeOverrideLater) globalThis.__smokeOverride = globalThis.__smokeOverrideLater;
  let res = null;
  for (let i = 0; i < 200 && !res; i++) { await sleep(100); res = [...document.querySelectorAll(S.res)].find(vis) || null }
  mo.disconnect();
  if (!res) return { ok: false, why: '等了 20 秒，那一列下方沒有出現結果句（鈕上出現過的字：' + [...seen].join('、') + '）' };
  if (!seen.has('切換中…')) return { ok: false, why: '送出後鈕沒有變成「切換中…」（出現過：' + [...seen].join('、') + '）' };
  const want = mode === 'ok' ? 'ok' : 'fail';
  if (!res.classList.contains(want)) return { ok: false, why: '結果句不是 ' + want + '：' + res.className + '「' + res.textContent.trim() + '」' };
  const text = res.textContent.trim();
  const expected = mode === 'ok' ? '已切換，' + name + ' 現在用這個帳號。' : '沒有切換成功：' + (mobile ? '那台的 ASN 尚未開啟。' : '找不到這個帳號的登入檔。');
  if (text !== expected) return { ok: false, why: '結果句寫「' + text + '」，應為「' + expected + '」' };
  // 位置：緊接在被按那一列之後、下一列之前；整張卡只有這一句
  if (res.previousElementSibling !== row) return { ok: false, why: '結果句不是緊接在被按的那一列後面' };
  const r = res.getBoundingClientRect(), k = row.getBoundingClientRect();
  if (r.top < k.bottom - 1) return { ok: false, why: '結果句在那一列上面或疊在列上（句 top ' + Math.round(r.top) + '、列 bottom ' + Math.round(k.bottom) + '）' };
  if (r.top - k.bottom > 16) return { ok: false, why: '結果句離那一列太遠：' + Math.round(r.top - k.bottom) + 'px' };
  const next = res.nextElementSibling;
  if (next && next.getBoundingClientRect().top < r.bottom - 1) return { ok: false, why: '結果句和下一列重疊' };
  if (r.right > card.getBoundingClientRect().right + 0.5 || r.left < card.getBoundingClientRect().left - 0.5) return { ok: false, why: '結果句超出帳號卡' };
  if ([...document.querySelectorAll(S.res)].filter(vis).length !== 1) return { ok: false, why: '畫面上不只一句結果' };
  if ([...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], .dlg, .m-sheet, .m-toast')].some(vis)) return { ok: false, why: '跳出了框或提示，結果應該只在原位顯示' };
  const color = getComputedStyle(res).color;
  const rgb = (color.match(/[0-9]+/g) || []).map(Number);
  if (mode === 'ok' && !(rgb[1] > rgb[0] && rgb[1] > rgb[2])) return { ok: false, why: '成功句不是綠色：' + color };
  if (mode === 'fail' && !(rgb[0] > rgb[1] + 40 && rgb[0] > rgb[2] + 40)) return { ok: false, why: '失敗句不是紅色：' + color };
  const bt = btn.textContent.trim();
  if (mode === 'ok') {
    if (bt !== '使用中') return { ok: false, why: '成功後那一列的鈕應為「使用中」，現在是「' + bt + '」' };
    for (let i = 0; i < 20 && !card.querySelector(S.cur); i++) await sleep(100);
    if (!mobile && !card.querySelector(S.cur)) return { ok: false, why: '成功後卡片頂端沒有「使用中」（和設備列不一致）' };
  } else {
    if (bt !== '切換' || btn.disabled) return { ok: false, why: '失敗後鈕應回到可按的「切換」，現在是「' + bt + '」' + (btn.disabled ? '（不能按）' : '') };
    if (!!card.querySelector(S.cur) !== hadCur) return { ok: false, why: '失敗了，卡片頂端的「使用中」卻變了' };
    await sleep(7000);
    if (![...document.querySelectorAll(S.res)].some(vis)) return { ok: false, why: '失敗句不該自己消失（要留到再按一次）' };
  }
  const info = (mobile ? '手機' : '電腦') + ' ' + mode + '：結果句「' + text + '」在列下 ' + Math.round(r.top - k.bottom) + 'px、寬 ' + Math.round(r.width) + 'px、顏色 ' + color + '、鈕 ' + [...seen].join('→') + '→' + bt;
  return { ok: true, why: info };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const base = { signedIn: true }
const desk = (name, mode) => ({ name, page: 'list.html', state: { ...base, devicesPage: true, roster: 'resets', rswitch: 'desktop-' + mode }, ready: '#app.win .dv-my .dv-acct', probe: { rswitch: 'desktop', mode, mail: 'me@example.com' } })
const phone = (name, mode) => ({ name, page: 'm.html', state: { ...base, mnoself: 'android', rswitch: 'mobile-' + mode }, ready: '#app.m .m-row-btn', probe: { rswitch: 'mobile', mode, mail: 'me@example.com', open: '帳號' } })

export default {
  key: 'rswitch',
  kind: '帳號卡設備列切換結果原位顯示檢查',
  source: probe => rswitchProbeSource(probe),
  scenarios: [desk('list-acct-switch-ok', 'ok'), desk('list-acct-switch-fail', 'fail'), phone('m-acct-switch-ok', 'ok'), phone('m-acct-switch-fail', 'fail')],
  table: scenario => {
    const k = scenario.state?.rswitch
    if (!k) return undefined
    if (k.startsWith('desktop-')) {
      // 本機有兩個帳號：you@ 在用、me@ 不在用 → me@ 卡上本機那一列是「切換」
      return {
        claude_accounts_list: [{ email: 'me@example.com', plan: 'claude_max', current: false }, { email: 'you@example.com', plan: 'claude_pro', current: true }],
        claude_account_switch: { email: 'me@example.com' },
        ...(k === 'desktop-fail' ? { __fail: { claude_account_switch: '找不到這個帳號的登入檔' } } : {}),
      }
    }
    return {
      android_acct_switch: { id: 's1' },
      android_acct_status: { switches: [{ id: 's1', status: 'ok' }] },
      ...(k === 'mobile-fail' ? { __fail: { android_acct_switch: 'android_acct_switch HTTP 409 asn_offline' } } : {}),
    }
  },
}
