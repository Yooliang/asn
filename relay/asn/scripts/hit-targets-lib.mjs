// 手機觸控目標棘輪（#1763 T3，hitTarget 探測）的純邏輯：頁面內的量測原始碼、違規清單的正規化與比對。
// 不開瀏覽器、不碰檔案系統，所以能直接單元測試（test/hit-targets.test.mjs）。真的量測由 scripts/hit-targets.mjs 在瀏覽器裡跑。
//
// 規矩：手機設定頁（每一類的內容頁）上，所有「可以點」的元素（button、a、input、select、textarea、role=button／tab／switch、summary）
// 寬或高小於 44px 的算違規。先把現況違規量成基準（test/golden/hit-targets-baseline.json），之後只准減少、不准增加：
//   - 基準裡沒有、現在多出來的違規＝新增（紅）
//   - 基準裡有的，現在最短邊又縮短超過 1px＝惡化（紅）
//   - 基準裡有、現在沒有的＝改善（提示可以用 --update 更新基準，不算失敗）
export const MIN_TARGET_PX = 44
export const WORSEN_SLACK_PX = 1
export const TEXT_MAX = 20

// 頁面內執行：量 root（預設手機設定內頁 .m-fourth）底下所有看得到、沒被停用的可點元素，回傳 { ok, why, total, violations: [{ tag, text, cls, w, h }] }
export const hitTargetSource = ({ rootSel = '#app.m .m-fourth', min = MIN_TARGET_PX, textMax = TEXT_MAX } = {}) => `(() => {
  try {
    const root = document.querySelector(${JSON.stringify(rootSel)});
    if (!root) return { ok: false, why: '找不到量測範圍 ' + ${JSON.stringify(rootSel)}, total: 0, violations: [] };
    const SEL = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [role=checkbox], [role=link]';
    const seen = new Set();
    const out = [];
    let total = 0;
    const shown = e => {
      if (!e.isConnected) return false;
      for (let n = e; n && n !== document.documentElement; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0') return false;
        if (n.hidden || n.getAttribute('aria-hidden') === 'true') return false;
      }
      return true;
    };
    for (let el of root.querySelectorAll(SEL)) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      // 勾選框、單選鈕本身很小，真正按的是包著它的整個標籤：量標籤
      if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) { const lab = el.closest('label'); if (lab) el = lab }
      if (seen.has(el)) continue;
      seen.add(el);
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      total++;
      const w = Math.round(r.width * 10) / 10, h = Math.round(r.height * 10) / 10;
      if (w >= ${Number(min)} && h >= ${Number(min)}) continue;
      const raw = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
      const cls = (typeof el.className === 'string' ? el.className : '').split(/\\s+/).filter(Boolean)[0] || '';
      out.push({ tag: el.tagName.toLowerCase(), text: [...raw].slice(0, ${Number(textMax)}).join(''), cls, w, h });
    }
    return { ok: true, why: '', total, violations: out };
  } catch (e) { return { ok: false, why: '量測丟出例外：' + (e && e.message), total: 0, violations: [] } }
})()`

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
// 固定排序：情境、標籤、文字、class、寬、高
export const sortViolations = list => [...list].sort((a, b) => cmp(a.scenario, b.scenario) || cmp(a.tag, b.tag) || cmp(a.text, b.text) || cmp(a.cls, b.cls) || a.w - b.w || a.h - b.h)
export const idOf = v => `${v.scenario}|${v.tag}|${v.text}|${v.cls}`
export const minSide = v => Math.min(v.w, v.h)
export const lineOf = v => `${v.scenario}  <${v.tag}>「${v.text}」${v.cls ? ` .${v.cls}` : ''}  ${v.w}×${v.h}`

// 基準檔格式：{ version, min, total, scenarios: { 名稱: 違規數 }, violations: [...排序後] }
export function makeBaseline({ scenarios, violations, min = MIN_TARGET_PX }) {
  const sorted = sortViolations(violations)
  const per = Object.fromEntries([...scenarios].sort().map(n => [n, sorted.filter(v => v.scenario === n).length]))
  return { version: 1, min, total: sorted.length, scenarios: per, violations: sorted }
}

// 基準檔自己要一致（總數、各情境數、排序固定），不然是被手改壞了
export function baselineProblems(b) {
  const bad = []
  if (!b || b.version !== 1) return ['基準檔版本不對']
  if (!Array.isArray(b.violations) || typeof b.scenarios !== 'object' || !b.scenarios) return ['基準檔格式不對']
  if (b.total !== b.violations.length) bad.push(`total ${b.total} 與違規筆數 ${b.violations.length} 不同`)
  const sorted = sortViolations(b.violations)
  if (JSON.stringify(sorted) !== JSON.stringify(b.violations)) bad.push('違規清單沒有照固定順序排')
  for (const [n, c] of Object.entries(b.scenarios)) if (b.violations.filter(v => v.scenario === n).length !== c) bad.push(`情境 ${n} 的違規數與清單不符`)
  for (const v of b.violations) if (!(v.scenario in b.scenarios)) bad.push(`違規屬於基準裡沒列的情境：${v.scenario}`)
  return bad
}

// 比對：同一個 id（情境|標籤|文字|class）可以有多筆，依最短邊由小到大一對一配對
export function compareHitTargets(baseline, current) {
  const group = list => { const m = new Map(); for (const v of list) { const k = idOf(v); if (!m.has(k)) m.set(k, []); m.get(k).push(v) } for (const a of m.values()) a.sort((x, y) => minSide(x) - minSide(y)); return m }
  const b = group(baseline.violations), c = group(current.violations)
  const added = [], worsened = [], improved = []
  for (const [k, cur] of c) {
    const old = b.get(k) ?? []
    cur.forEach((v, i) => {
      if (i >= old.length) added.push(v)
      else if (minSide(v) < minSide(old[i]) - WORSEN_SLACK_PX) worsened.push({ now: v, was: old[i] })
    })
  }
  for (const [k, old] of b) { const cur = c.get(k) ?? []; for (let i = cur.length; i < old.length; i++) improved.push(old[i]) }
  // 量測範圍：基準裡有、這次沒量到的情境（情境被拿掉或沒掛上）也要說，不能靠「沒量到＝沒違規」過關
  const unmeasured = Object.keys(baseline.scenarios).filter(n => !(current.scenarios ?? []).includes(n))
  return { added, worsened, improved, unmeasured, ok: !added.length && !worsened.length && !unmeasured.length }
}
