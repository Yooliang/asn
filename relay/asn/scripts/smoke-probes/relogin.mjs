// 冒煙探測「手機重新登入 Claude 檢查」（probe.relogin，#1512 C、#1592）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 那台電腦回報 Claude 登入失效時，設備細部頁的 Claude 區出現「重新登入 Claude」（安裝入口的總開關關著也有）；
// 按了只進確認（確認字寫明登入網址送到這支手機、登入正常會告訴你不需要重新登入），按「確認重新登入」才送出要求
// （同一個 setup_remote_request，帶那台的節點與 mode: relogin）。另一台沒回報失效的：沒有這顆。全部用真的點擊（__smokeInput）。
// 情境（probe.relogin 的值）：
//   base     送出的要求帶對的欄位，不亂帶
//   failed   電腦回報失敗（沒安裝 Claude Code）：結果用 role="alert"、加框、捲到看得見，寫出原因與下一步
//   wait     電腦還沒來取（它跟著 60 秒一次的在線回報才來取）：送出 25 秒時還要說「等這台電腦來取」，不能說沒有回應
//   noreply  電腦一直沒接手：超過 90 秒才顯示「這台電腦沒有回應」並結束
//   （等待時間用「注入腳本把這個頁面的 Date.now 往前推」縮短，只在探測自己的頁面生效；點擊都是真的，正式程式沒有任何可改等待時間的入口）
//   healthy  電腦回報目前登入正常：顯示「不需要重新登入」，不是警示
//   already  後台說已經有進行中的要求：明說，再顯示它的狀態
// 探測原始碼是字串，裡面不寫反斜線

export const NOT_INSTALLED = '這台電腦還沒安裝 Claude Code，重新登入不會替你安裝；要安裝請在這台電腦打開「允許從手機安裝並登入」'
export const LOGIN_OK = '這台電腦的 Claude 目前登入正常，不需要重新登入'

export const reloginProbeSource = (kind = 'base') => `(async () => {
  const KIND = ${JSON.stringify(kind)};
  const MODE = KIND === 'anim' ? 'anim' : 'still';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 400) };
  const tap = async el => { el.scrollIntoView({ block: 'center' }); await sleep(120); await real({ click: at(el) }) };
  const wait = async (fn, n = 60) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const sent = () => (globalThis.__smokeCalls || []).filter(c => c[0] === 'setup_remote_request');
  const prog = () => [...document.querySelectorAll('.m-dv-setup .m-dv-prog')].find(vis);
  const inView = el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight };
  const btn = await wait(() => [...document.querySelectorAll('.m-row-btn')].find(b => vis(b) && b.textContent.includes('設備')));
  if (!btn) return { ok: false, why: '找不到設定裡的「設備」' };
  await tap(btn);
  const openDevice = async name => {
    const row = await wait(() => [...document.querySelectorAll('.m-dv-row')].filter(vis).find(r => (r.querySelector('.m-dv-rn b')?.textContent ?? '').trim() === name));
    if (!row) return false;
    await tap(row.querySelector('.m-dv-go'));
    const go = await wait(() => [...row.querySelectorAll('.m-dv-accbtn')].find(vis));
    if (!go) return false;
    await tap(go);
    return !!(await wait(() => [...document.querySelectorAll('.m-dv-vendor')].some(vis)));
  };
  if (!(await openDevice('辦公室'))) return { ok: false, why: '打不開「辦公室」的細部頁' };
  // 使用中又登入失效（#1592）：右上同一格交替，沒有獨立的紅色標籤
  const cur = await wait(() => [...document.querySelectorAll('.m-dv-cur.failed')].find(vis), 200);
  if (!cur) return { ok: false, why: '辦公室目前帳號登入失效，右上那一格卻沒有「使用中／登入失效」交替格' };
  if (cur.closest('.m-dv-acct').querySelector('.m-dv-failed')) return { ok: false, why: '使用中的帳號只走交替格，不該再有獨立的紅色「登入失效」標籤' };
  // 沒在使用、但登入失效的帳號（假資料另給一張）：保留獨立的紅標籤，不是交替格
  const offCard = await wait(() => [...document.querySelectorAll('.m-dv-acct')].filter(vis).find(c => (c.querySelector('.m-dv-mail')?.textContent ?? '').trim() === 'old@example.com'), 100);
  if (!offCard) return { ok: false, why: '找不到沒在使用、登入失效的帳號卡' };
  const tag = offCard.querySelector('.m-dv-failed');
  if (!tag || !vis(tag) || tag.textContent.trim() !== '登入失效') return { ok: false, why: '沒在使用但登入失效的帳號，沒有獨立的紅色「登入失效」標籤' };
  if (offCard.querySelector('.m-dv-cur') || document.querySelectorAll('.m-dv-failed').length !== 1) return { ok: false, why: '沒在使用的帳號不該有「使用中」交替格，獨立標籤也只該有這一個' };
  if (getComputedStyle(tag).backgroundColor !== 'rgb(179, 38, 30)') return { ok: false, why: '獨立標籤不是紅底：' + getComputedStyle(tag).backgroundColor };
  if (cur.getAttribute('aria-label') !== '使用中，登入失效') return { ok: false, why: 'aria-label 不對：' + cur.getAttribute('aria-label') };
  const ta = cur.querySelector('.m-dv-cur-a'), tb = cur.querySelector('.m-dv-cur-b');
  if (!ta || !tb || ta.textContent.trim() !== '使用中' || tb.textContent.trim() !== '登入失效') return { ok: false, why: '交替的兩個字不對' };
  if (ta.getAttribute('aria-hidden') !== 'true' || tb.getAttribute('aria-hidden') !== 'true') return { ok: false, why: '交替的兩個字要 aria-hidden' };
  const ra = ta.getBoundingClientRect(), rb = tb.getBoundingClientRect(), rc = cur.getBoundingClientRect();
  if (Math.abs(ra.left - rb.left) > 0.5 || Math.abs(ra.top - rb.top) > 0.5) return { ok: false, why: '兩個字沒有疊在同一格' };
  if (rc.width + 0.5 < Math.max(ta.scrollWidth, tb.scrollWidth)) return { ok: false, why: '格寬比較寬的字還窄：' + rc.width };
  const cs = e => getComputedStyle(e);
  if (MODE === 'anim') {
    // 沒開減少動態：三個元素都在跑動畫（交替由 CSS 做，不靠計時器）
    if (![cur, ta, tb].every(e => cs(e).animationName !== 'none' && cs(e).animationDuration === '2s')) return { ok: false, why: '沒有開減少動態時，交替動畫沒在跑：' + [cur, ta, tb].map(e => cs(e).animationName).join('/') };
  } else {
    // 開了減少動態：不交替，固定顯示紅色「登入失效」
    if (cs(cur).animationName !== 'none' || cs(ta).opacity !== '0' || cs(tb).opacity !== '1' || cs(cur).backgroundColor !== 'rgb(179, 38, 30)') return { ok: false, why: '減少動態時沒有固定顯示紅色「登入失效」：' + cs(cur).backgroundColor + ' a=' + cs(ta).opacity + ' b=' + cs(tb).opacity };
  }
  // 使用中但沒有失效的卡（辦公室另有一個使用中的 Codex 帳號）：維持單純的「使用中」，交替動畫不能跑、字不能變透明
  const plain = await wait(() => [...document.querySelectorAll('.m-dv-cur:not(.failed)')].find(vis), 100);
  if (!plain) return { ok: false, why: '找不到使用中但沒失效的帳號卡（驗證用的 Codex 帳號）' };
  const pa = plain.querySelector('.m-dv-cur-a');
  if (!pa || cs(pa).animationName !== 'none' || cs(pa).opacity !== '1' || cs(plain).animationName !== 'none' || plain.querySelector('.m-dv-cur-b') || plain.hasAttribute('aria-label')) return { ok: false, why: '沒失效的「使用中」不該有交替：a 動畫=' + (pa && cs(pa).animationName) + ' 透明度=' + (pa && cs(pa).opacity) + ' 格動畫=' + cs(plain).animationName };
  const relogin = await wait(() => [...document.querySelectorAll('.m-dv-relogin')].find(vis), 200);   // 帳號回報讀回來才有入口：全套並行跑時比較慢，多等一點
  if (!relogin) return { ok: false, why: '那台回報 Claude 登入失效，細部頁卻沒有「重新登入 Claude」' };
  if (relogin.textContent.trim() !== '重新登入 Claude') return { ok: false, why: '按鈕的字不對：' + relogin.textContent };
  if ([...document.querySelectorAll('.m-dv-setup .m-btn')].filter(vis).some(b => b.textContent.includes('安裝並登入'))) return { ok: false, why: '安裝入口的總開關關著，不該出現「從手機安裝並登入」' };
  await tap(relogin);
  const dlg = await wait(() => [...document.querySelectorAll('.m-dv-confirm')].find(vis));
  if (!dlg) return { ok: false, why: '按了沒有進確認' };
  if (sent().length) return { ok: false, why: '按鈕不能直接送出，要先確認' };
  const dt = dlg.textContent;
  if (!dt.includes('重新登入 Claude 嗎') || !dt.includes('那台電腦會把登入網址送到這支手機') || !dt.includes('如果那台目前登入正常，會告訴你不需要重新登入')) return { ok: false, why: '確認字沒寫清楚（要寫登入網址送到這支手機、登入正常會告訴你不需要重新登入）：' + dt.slice(0, 120) };
  if (dt.includes('允許從手機替這台安裝並登入')) return { ok: false, why: '重新登入不受安裝開關限制，確認字不該要求打開它' };
  const yes = [...dlg.querySelectorAll('.m-btn')].find(b => b.textContent.trim() === '確認重新登入');
  if (!yes) return { ok: false, why: '找不到「確認重新登入」' };
  await tap(yes);
  if (!(await wait(() => sent().length === 1))) return { ok: false, why: '按了確認沒有送出要求（或送了不只一次）：' + sent().length };
  const args = sent()[0][1] || {};
  if (JSON.stringify(Object.keys(args).sort()) !== JSON.stringify(['mode', 'node']) || args.node !== 'Q' || args.mode !== 'relogin') return { ok: false, why: '要求只帶那台的節點與 mode: relogin，不帶別的：' + JSON.stringify(args) };
  if (KIND === 'failed') {
    const p = await wait(() => { const e = prog(); return e && e.getAttribute('role') === 'alert' ? e : null }, 80);
    if (!p) return { ok: false, why: '電腦回報失敗，手機沒有出現 role=alert 的結果：' + (prog()?.outerHTML ?? '沒有結果區').slice(0, 160) };
    if (!p.textContent.includes('這台電腦還沒安裝 Claude Code') || !p.textContent.includes('打開「允許從手機安裝並登入」')) return { ok: false, why: '失敗的原因與下一步沒寫出來：' + p.textContent };
    if (!p.classList.contains('fail') || getComputedStyle(p).borderTopWidth === '0px') return { ok: false, why: '失敗的結果沒有加框，不夠醒目' };
    await sleep(900);
    if (!inView(p)) return { ok: false, why: '失敗的結果不在看得見的地方' };
  } else if (KIND === 'noreply') {
    const waiting = await wait(() => prog(), 30);
    if (!waiting || waiting.getAttribute('role') !== 'status' || !waiting.textContent.includes('要求已送出')) return { ok: false, why: '剛送出時應該是等電腦接手的狀態（role=status）：' + (waiting?.textContent ?? '沒有結果區') };
    await sleep(4000);   // 查狀態每 5 秒一次：這時剛好等到下一輪之前，調快時鐘後馬上就會查到
    if (!prog() || prog().getAttribute('role') !== 'status') return { ok: false, why: '還沒到 90 秒就不該結束：' + (prog()?.textContent ?? '') };
    // 調快時鐘 91 秒（不真的等）：下一輪查狀態（每 5 秒）就該看到「沒有回應」
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + 91000;
    // 先把畫面捲到最上面，結果出來後要自己捲回看得見的地方
    for (let e = prog(); e; e = e.parentElement) if (e.scrollHeight > e.clientHeight + 1) e.scrollTop = 0;
    const p = await wait(() => { const e = prog(); return e && e.getAttribute('role') === 'alert' ? e : null }, 100);
    Date.now = realNow;
    if (!p) return { ok: false, why: '送出超過 90 秒電腦都沒接手，手機沒有說沒有回應：' + (prog()?.textContent ?? '沒有結果區') };
    if (!p.textContent.includes('這台電腦沒有回應，請確認它的 ASN 開著，稍後再試')) return { ok: false, why: '沒有回應的說明不對：' + p.textContent };
    await sleep(900);
    if (!inView(p)) return { ok: false, why: '失敗的結果不在看得見的地方' };
    if (![...p.querySelectorAll('.m-btn')].some(b => b.textContent.trim() === '關閉')) return { ok: false, why: '結束後要有「關閉」' };
  } else if (KIND === 'wait') {
    const waiting = await wait(() => prog(), 30);
    if (!waiting) return { ok: false, why: '送出後沒有結果區' };
    await sleep(4000);
    // 調快時鐘 25 秒：電腦還沒來取是正常的（它每 60 秒才回報一次），不能說沒有回應
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + 25000;
    await sleep(2500);   // 等下一輪查狀態（每 5 秒）跑過
    Date.now = realNow;
    const p = prog();
    if (!p || p.getAttribute('role') !== 'status' || !p.textContent.includes('等這台電腦來取（最多約 1 分鐘）')) return { ok: false, why: '送出 25 秒時應該還在等電腦來取，不該結束或說沒有回應：' + (p?.textContent ?? '沒有結果區') };
    if (p.textContent.includes('沒有回應')) return { ok: false, why: '送出才 25 秒就說沒有回應' };
  } else if (KIND === 'healthy') {
    const p = await wait(() => { const e = prog(); return e && e.textContent.includes('不需要重新登入') ? e : null }, 80);
    if (!p) return { ok: false, why: '電腦回報登入正常，手機沒有說不需要重新登入：' + (prog()?.textContent ?? '沒有結果區') };
    if (p.getAttribute('role') === 'alert' || p.classList.contains('fail')) return { ok: false, why: '登入正常不是失敗，不該用警示顯示' };
    if (!p.querySelector('b.ok')) return { ok: false, why: '登入正常應該用成功的樣式' };
    if (!p.textContent.includes('這台電腦的 Claude 目前登入正常，不需要重新登入')) return { ok: false, why: '文字不對：' + p.textContent };
  } else if (KIND === 'already') {
    const p = await wait(() => { const e = prog(); return e && e.textContent.includes('這台電腦已經有一個進行中的要求') ? e : null }, 80);
    if (!p) return { ok: false, why: '後台說已經有進行中的要求，手機沒有明說：' + (prog()?.textContent ?? '沒有結果區') };
    if (!(await wait(() => prog() && prog().textContent.includes('已接手'), 80))) return { ok: false, why: '明說之後還要顯示它的狀態（已接手）：' + prog().textContent };
  }
  if (document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '整頁橫向溢出' };
  return { ok: true, why: '' };
})()`

const CASES = [
  { name: 'm-relogin', kind: 'base', shot: 'm-relogin.png' },
  // 沒開減少動態：不截圖（動畫畫面每次不同），只驗交替動畫真的在跑（#1592 B）
  { name: 'm-relogin-anim', kind: 'anim' },
  // 兩種外觀各一張（減少動態＝固定畫面）
  { name: 'm-relogin-modern', kind: 'base', skin: 'modern', shot: 'm-relogin-modern.png' },
  { name: 'm-relogin-line', kind: 'base', skin: 'line', shot: 'm-relogin-line.png' },
  { name: 'm-relogin-failed', kind: 'failed', shot: 'm-relogin-failed.png' },
  { name: 'm-relogin-wait', kind: 'wait', shot: 'm-relogin-wait.png' },
  { name: 'm-relogin-noreply', kind: 'noreply', shot: 'm-relogin-noreply.png' },
  { name: 'm-relogin-healthy', kind: 'healthy', shot: 'm-relogin-healthy.png' },
  { name: 'm-relogin-already', kind: 'already', shot: 'm-relogin-already.png' },
]

// 電腦（Q）對這次要求的回報；沒有就是一直沒接手
const statusOf = kind => {
  const at = new Date().toISOString()
  if (kind === 'failed') return { nodes: [{ id: 'Q', setup: { state: 'failed', detail: NOT_INSTALLED, replaced: null, at } }] }
  if (kind === 'healthy') return { nodes: [{ id: 'Q', setup: { state: 'done', detail: LOGIN_OK, replaced: null, at } }] }
  if (kind === 'already') return { nodes: [{ id: 'Q', setup: { state: 'taken', detail: null, replaced: null, at } }] }
  return { nodes: [] }
}

export default {
  key: 'relogin',
  kind: '手機重新登入 Claude 檢查',
  source: probe => reloginProbeSource(typeof probe.relogin === 'string' ? probe.relogin : 'base'),
  // 除了 anim，都開減少動態：截圖固定，交替格固定顯示紅色「登入失效」
  scenarios: CASES.map(c => ({ name: c.name, page: 'm.html', state: { signedIn: true, mlayout: true, relogin: c.kind, ...(c.skin ? { skin: c.skin } : {}) }, ready: '#app.m .m-row-btn', probe: { relogin: c.kind }, ...(c.shot ? { shot: c.shot } : {}), ...(c.kind === 'anim' ? {} : { reducedMotion: true }) })),
  // 辦公室（Q）回報目前的 Claude 帳號登入失效；送出要求與查狀態都只記下來
  table: (scenario, t) => {
    if (!scenario.state?.relogin) return undefined
    const list = t.android_acct_list
    const q = list?.values?.Q
    if (!q) return undefined
    const accounts = [...q.accounts.map(a => (a.vendor === 'claude' && a.current ? { ...a, login_failed: true } : a)), { vendor: 'claude', email: 'old@example.com', plan: 'pro', current: false, login_failed: true }, { vendor: 'codex', email: 'codex@example.com', plan: '', current: true }]
    // 回報時間用跑這個情境的當下算（全套跑完要二十幾分鐘，載入時算的時間到這裡已經過舊，入口照規則就不給）
    const reportedAt = new Date(Math.floor((Date.now() - 5 * 60_000) / 60_000) * 60_000).toISOString()
    const kind = typeof scenario.state.relogin === 'string' ? scenario.state.relogin : 'base'
    const request = kind === 'already' ? { ok: true, already: true, state: 'taken' } : { ok: true }
    return { android_acct_list: { ...list, values: { ...list.values, Q: { ...q, reported_at: reportedAt, accounts } } }, setup_remote_request: request, setup_remote_status: statusOf(kind) }
  },
}
