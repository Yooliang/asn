// 設定項目「效果紀錄」（#1763 T4）的純邏輯：頁面內的控制項列舉與操作（原始碼字串，由 settings-effects.mjs 注入）、
// 指令參數正規化、prefs／localStorage 前後差異、金鑰掃描、跟 golden 的比對。不開瀏覽器、不碰檔案，所以能直接單元測試（test/settings-effects.test.mjs）。
//
// 做法：在真瀏覽器開設定頁（電腦每一類、手機每一類），對頁內每個控制項「真的操作一次」（勾選、選一項、輸入後 change、按鈕），
// 記下操作後假 Tauri 收到的指令（名稱＋參數）、設定檔（me）欄位的前後差異、localStorage 的前後差異。
// 控制項用「種類＋畫面上的字＋同字第幾個」辨認，不用 class 或位置，所以內部換成 asn-* 元件後，只要使用者看到的字與效果相同，紀錄就一樣。

export const GOLDEN_VERSION = 1
export const SETTLE_AFTER_MS = 1000  // 操作後等多久再收紀錄（設定存檔有佇列）

// ---------- 頁面內：假 Tauri 的指令紀錄（在 injectSource 之後、頁面程式之前執行）----------
export const recorderSource = () => `(() => {
  const T = globalThis.__TAURI__;
  if (!T || !T.core) return;
  const inv = T.core.invoke;
  globalThis.__rec = [];
  globalThis.__openLog = [];
  T.core.invoke = async (cmd, args) => {
    let a = null;
    try { a = args === undefined ? null : JSON.parse(JSON.stringify(args)); } catch (e) { a = '(參數無法序列化)'; }
    const r = { cmd, args: a };
    globalThis.__rec.push(r);
    try { return await inv(cmd, args); } catch (e) { r.err = String(e && e.message ? e.message : e).slice(0, 100); throw e; }
  };
  window.open = (u) => { globalThis.__openLog.push(String(u)); return null; };
  // 連結不真的離開頁面（記在 __openLog）；只擋預設動作，頁面自己的點擊處理照跑
  document.addEventListener('click', ev => {
    const a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (a) { globalThis.__openLog.push('a:' + a.getAttribute('href')); ev.preventDefault(); }
  }, true);
})();`

// ---------- 頁面內：列舉與操作控制項 ----------
// rootSel：電腦＝設定分頁；手機＝內頁（.m-fourth，可見的那個）。kind 'none'＝不操作，只量背景底噪
export const fxHelperSource = rootSel => `(() => {
  const vis = e => !!e && e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden';
  // 結尾的箭頭符號（手機的「官網↗」「版本紀錄▸」）不算字：電腦與手機同一個項目才認得是同一個
  const clean = s => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().replace(/\\s*[▸▶↗↘→▾▴›»]+$/, '').slice(0, 48);
  const roots = () => [...document.querySelectorAll(${JSON.stringify(rootSel)})].filter(vis);
  const SEL = 'input, select, textarea, button, a[href], [role="button"], [role="switch"], [role="checkbox"], [role="radio"], summary';
  const own = el => clean(el.getAttribute('aria-label') || el.getAttribute('title') || '');
  const textOf = node => { const c = node.cloneNode(true); for (const x of c.querySelectorAll('select, input, textarea, option, svg, script, style')) x.remove(); return clean(c.textContent); };
  const kindOf = el => {
    const tag = el.tagName.toLowerCase(), role = el.getAttribute('role');
    if (tag === 'input') { const t = (el.getAttribute('type') || 'text').toLowerCase(); return ['checkbox', 'radio', 'file', 'range', 'number', 'button', 'submit'].includes(t) ? (t === 'submit' ? 'button' : t) : 'text'; }
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'text';
    if (tag === 'a') return 'link';
    if (role === 'switch' || role === 'checkbox') return 'switch';
    if (role === 'radio') return 'radio';
    return 'button';
  };
  const labelOf = (el, kind) => {
    const lab = el.closest('label');
    if (['checkbox', 'radio', 'switch'].includes(kind)) return (lab ? textOf(lab) : '') || own(el) || textOf(el) || clean(el.nextSibling && el.nextSibling.textContent) || '(無字)';
    if (kind === 'select' || kind === 'text' || kind === 'number' || kind === 'range') {
      const l = lab ? textOf(lab) : '';
      let prev = '';
      for (let p = el.previousElementSibling; p && !prev; p = p.previousElementSibling) prev = textOf(p);
      return l || own(el) || clean(el.getAttribute('placeholder')) || prev || clean(el.getAttribute('name')) || '(無字)';
    }
    return textOf(el) || own(el) || '(無字)';
  };
  const list = () => {
    const rs = roots();
    if (!rs.length) return null;
    const seen = new Map();
    const out = [];
    for (const el of rs.flatMap(r => [...r.querySelectorAll(SEL)])) {
      if (!vis(el) || el.disabled || el.closest('[aria-hidden="true"]')) continue;
      const kind = kindOf(el);
      const label = labelOf(el, kind);
      const key = kind + '|' + label;
      const n = (seen.get(key) || 0) + 1; seen.set(key, n);
      out.push({ el, kind, label, nth: n });
    }
    return out;
  };
  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const operate = (el, kind) => {
    el.scrollIntoView && el.scrollIntoView({ block: 'center' });
    if (kind === 'checkbox' || kind === 'radio' || kind === 'switch') { const was = el.checked; el.click(); return kind === 'radio' ? (was ? '點選（原本就選著）' : '點選') : (was ? '取消勾選' : '勾選'); }
    if (kind === 'select') {
      const opts = [...el.options].filter(o => !o.disabled);
      const i = opts.findIndex(o => o.value === el.value);
      const next = opts[(i + 1) % opts.length];
      if (!next) return '沒有可選的項目';
      el.value = next.value; fire(el, 'input'); fire(el, 'change');
      return '選「' + clean(next.textContent) + '」';
    }
    if (kind === 'number' || kind === 'range') {
      const min = el.min === '' ? 0 : Number(el.min), max = el.max === '' ? 1e9 : Number(el.max);
      const v = Math.min(max, Math.max(min, (Number(el.value) || 0) + 1));
      el.focus(); el.value = String(v); fire(el, 'input'); fire(el, 'change'); el.blur();
      return '輸入 ' + v;
    }
    if (kind === 'text') { el.focus(); el.value = '測試值'; fire(el, 'input'); fire(el, 'change'); el.blur(); return '輸入「測試值」'; }
    el.click();
    return '按一下';
  };
  const dialogText = () => {
    const d = [...document.querySelectorAll('.dlg-back, .partner-dlg-back, [role="dialog"], .m-ops')].find(vis);
    return d ? clean(d.textContent).slice(0, 60) : null;
  };
  // 記下設定元件對名單視窗送出的 act（op 名＋值）：只為了知道「這個控制項走了哪個 op」（SETTING_OPS 的覆蓋對照）；
  // 做法是在執行時把設定元件那個實例的 onAct 包一層，不改任何正式程式。電腦版才有（手機是 v-model 直接 invoke，沒有 act）
  const hookAct = () => {
    globalThis.__acts = globalThis.__acts || [];
    // 正式版的 Vue 不在 DOM 上留元件實例，所以從根實例沿著虛擬節點樹往下找（#app 的 __vue_app__ 正式版也有）
    const app = document.querySelector('#app');
    const found = [];
    const seenNodes = new Set();
    const walkInst = inst => {
      if (!inst || seenNodes.has(inst)) return;
      seenNodes.add(inst);
      const t = inst.type || {};
      if (t.emits && t.props && t.props.catKey) found.push(inst);
      walkNode(inst.subTree);
    };
    const walkNode = vn => {
      if (!vn || typeof vn !== 'object') return;
      if (vn.component) walkInst(vn.component);
      if (Array.isArray(vn.children)) for (const c of vn.children) walkNode(c);
      if (vn.suspense && vn.suspense.activeBranch) walkNode(vn.suspense.activeBranch);
    };
    if (app && app._vnode) walkNode(app._vnode);   // 正式版沒有 app._instance，但容器上的 _vnode（根虛擬節點）一直都在
    for (const c of found) {
      if (!c.vnode.props || c.vnode.props.__fxHooked) continue;
      const orig = c.vnode.props.onAct;
      c.vnode.props.__fxHooked = true;
      c.vnode.props.onAct = (...a) => { try { globalThis.__acts.push({ op: a[0], value: null }); } catch (e) { /* 記不下就算了 */ } return typeof orig === 'function' ? orig(...a) : (Array.isArray(orig) ? orig.forEach(f => f(...a)) : undefined); };
    }
  };
  const lsAll = () => { const o = {}; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } } catch (e) {} return o; };
  globalThis.__fx = {
    items: () => { const l = list(); return l ? l.map(x => ({ kind: x.kind, label: x.label, nth: x.nth })) : null; },
    // steps：依序操作的控制項（最後一個才是這筆紀錄的主角，前面的只是把畫面帶到那裡）；空陣列＝不操作，只量背景底噪。
    // 回傳最後一步的指令、前後差異，以及它讓畫面多出來的控制項（reveals，供第二層操作）
    run: async (steps, wait) => {
      hookAct();
      let input = '(不操作，量背景底噪)', reveals = [];
      let start = globalThis.__rec.length, openStart = globalThis.__openLog.length, actStart = (globalThis.__acts || []).length, ls0 = lsAll();
      for (let i = 0; i < steps.length; i++) {
        const l = list();
        if (!l) return { ok: false, why: '設定頁不見了' };
        const s = steps[i];
        const it = l.find(x => x.kind === s.kind && x.label === s.label && x.nth === s.nth);
        if (!it) return { ok: false, why: '找不到控制項 ' + s.kind + '／' + s.label + '／' + s.nth };
        const before = new Set(l.map(x => x.kind + '|' + x.label + '|' + x.nth));
        start = globalThis.__rec.length; openStart = globalThis.__openLog.length; actStart = (globalThis.__acts || []).length; ls0 = lsAll();
        input = operate(it.el, s.kind);
        await new Promise(r => setTimeout(r, wait));
        const after = list() || [];
        reveals = after.filter(x => !before.has(x.kind + '|' + x.label + '|' + x.nth)).map(x => ({ kind: x.kind, label: x.label, nth: x.nth }));
        hookAct();
      }
      return { ok: true, input, reveals, calls: globalThis.__rec.slice(start), opened: globalThis.__openLog.slice(openStart), acts: (globalThis.__acts || []).slice(actStart), dialog: dialogText(), ls0, ls1: lsAll() };
    },
  };
  return true;
})()`

// ---------- 正規化 ----------
// 時間（現在±30天內的毫秒數或 ISO 字串）換成 <現在>，不然每次跑都不同；其餘值原樣保留
const DAY = 24 * 3600 * 1000
export const maskTime = (value, nowMs) => {
  const near = n => Math.abs(n - nowMs) < 30 * DAY
  const walk = v => {
    if (typeof v === 'number') return Number.isFinite(v) && v > 1e11 && near(v) ? '<現在>' : v
    if (typeof v === 'string') {
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) { const t = Date.parse(v); if (Number.isFinite(t) && near(t)) return '<現在>' }
      return v
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, walk(v[k])]))
    return v
  }
  return walk(value)
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
// 把巢狀物件攤成 路徑→值（只攤物件，陣列當一個值）
const flat = (v, prefix = '', out = {}) => {
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) { for (const k of Object.keys(v).sort()) flat(v[k], prefix ? `${prefix}.${k}` : k, out) } else out[prefix] = v
  return out
}
// 設定檔（me）的存檔指令：內容改用 prefs 欄位差異表示，不放進指令序列
const isMeSave = c => (c.cmd === 'settings_patch' || c.cmd === 'store_save') && c.args && c.args.name === 'me'
// prefs 差異：settings_patch（name='me'）送出的欄位跟「操作前的 me」比，列出真的變了的路徑；store_save 的整份文字也同樣比
export const diffPrefs = (beforeMe, calls) => {
  const before = flat(beforeMe ?? {})
  const changed = new Map()
  const note = obj => {
    for (const [p, v] of Object.entries(flat(obj))) {
      if (p === '') continue
      if (!(p in before) ? v !== undefined : !same(before[p], v)) changed.set(p, { path: p, from: p in before ? before[p] : null, to: v })
    }
  }
  for (const c of calls) {
    if (c.cmd === 'settings_patch' && c.args && c.args.name === 'me' && c.args.patch) note(c.args.patch)
    if (c.cmd === 'store_save' && c.args && c.args.name === 'me' && typeof c.args.text === 'string') { try { note(JSON.parse(c.args.text)) } catch { /* 不是 JSON 就只留在指令序列裡 */ } }
  }
  return [...changed.values()].sort((a, b) => a.path.localeCompare(b.path))
}
// 起始的 me（假後台給的）疊上「不操作」那次量到的存檔＝操作前的實際狀態；之後只看操作多改了什麼
export const baselineMe = (initialMe, baseCalls) => {
  const me = { ...(initialMe ?? {}) }
  for (const c of baseCalls) {
    if (c.cmd === 'settings_patch' && c.args?.name === 'me' && c.args.patch) Object.assign(me, c.args.patch)
    if (c.cmd === 'store_save' && c.args?.name === 'me' && typeof c.args.text === 'string') { try { Object.assign(me, JSON.parse(c.args.text)) } catch { /* 不是 JSON 略過 */ } }
  }
  return me
}
// 背景底噪：不操作也會一直呼叫的指令（輪詢）。同一個「指令＋參數」，前「底噪次數＋1」次不算這次操作的效果（容許計時誤差 1 次），超出的才留下
// 固定的底噪：名單視窗自己輪詢（local_windows、term_list）與寫畫面記錄（ui_log）；次數看計時與有幾個指令被假後台拒絕，每次不同，跟使用者的操作無關
// snap_max_set／snap_max_clear：自畫放大鈕把自己的位置回報給 Rust（#1788），換外觀時跟著版面重量，是版面幾何、不是設定的效果；
// 有沒有這兩個指令只看放大鈕存不存在，放進來免得 #1788 進出 main 時 golden 跟著變
export const NOISE_CMDS = ['local_windows', 'term_list', 'ui_log', 'snap_max_set', 'snap_max_clear']
export const dropNoise = (calls0, baseCalls) => {
  const calls = calls0.filter(c => !NOISE_CMDS.includes(c.cmd))
  const key = c => c.cmd + '|' + JSON.stringify(c.args)
  const allow = new Map()
  for (const c of baseCalls) allow.set(key(c), (allow.get(key(c)) ?? 1) + 1)
  return calls.filter(c => {
    const k = key(c)
    const left = allow.get(k)
    if (left === undefined) return true
    if (left > 0) { allow.set(k, left - 1); return false }
    return true
  })
}
export const diffStorage = (before, after) => {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort()
  return keys.filter(k => before?.[k] !== after?.[k]).map(k => ({ key: k, from: before?.[k] ?? null, to: after?.[k] ?? null }))
}

// ---------- 金鑰掃描（golden 裡不准出現金鑰、token、真實帳號）----------
export const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{16,}/, 'sk- 開頭的金鑰'],
  [/\bghp_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/\bxox[abp]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\./, 'JWT'],
  [/\bBearer\s+[A-Za-z0-9._-]{16,}/i, 'Bearer token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私鑰'],
  [/\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)"?\s*[:=]\s*"[^"]{6,}/i, '密碼／金鑰欄位帶值'],
  [/[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, '非 example.* 的電子郵件（真實帳號）'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/])/, '40 字以上的連續金鑰樣字串'],
]
export const findSecrets = text => SECRET_PATTERNS.flatMap(([re, why]) => { const m = String(text).match(re); return m ? [`${why}：${m[0].slice(0, 24)}…`] : [] })

// ---------- 紀錄的格式 ----------
// via＝先按了哪個控制項才出現的第二層控制項（例如先按「詳情」才看得到的按鈕）
export const entryId = e => `${e.platform}|${e.cat}|${e.via ? e.via + '>' : ''}${e.kind}|${e.label}#${e.nth}`
export const sortEntries = list => [...list].sort((a, b) => { const x = entryId(a), y = entryId(b); return x < y ? -1 : x > y ? 1 : 0 })

// 平台專屬：同一類裡，這個「種類＋字」只有一個平台有，就標專屬；整類只有電腦有的（手機沒有該類）也標專屬
export const markPlatformOnly = (entries, { deskCats, phoneCats }) => {
  const sig = e => `${e.cat}|${e.kind}|${e.label}`
  const has = { desk: new Set(), phone: new Set() }
  for (const e of entries) has[e.platform].add(sig(e))
  return entries.map(e => {
    const other = e.platform === 'desk' ? 'phone' : 'desk'
    const otherCats = e.platform === 'desk' ? phoneCats : deskCats
    const only = !otherCats.includes(e.cat) || !has[other].has(sig(e))
    return { ...e, platformOnly: only ? e.platform : null }
  })
}

// 設定檔第一次存檔時會把整份預設值一起寫出去（跟哪個控制項無關）：同一類裡，一個欄位在 2 個以上控制項的存檔裡都出現、而且值全都一樣，
// 就是「預設值跟著寫」，不是那個控制項的效果，從各筆的 prefs 拿掉（改變值的欄位每筆各不同，不會被誤刪）
export const stripDefaultWrites = entries => {
  const groups = new Map()
  for (const e of entries) { const k = e.platform; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e) }   // 預設值每一類都一樣，所以整個平台一起看
  const noise = new Map()
  for (const [k, list] of groups) {
    const seen = new Map()
    for (const e of list) for (const p of e.prefs) { const s = seen.get(p.path) ?? { n: 0, vals: new Map() }; s.n++; const v = JSON.stringify(p.to); s.vals.set(v, (s.vals.get(v) ?? 0) + 1); seen.set(p.path, s) }
    // 路徑 → 預設值（序列化）：全部一樣（至少 2 筆），或至少 3 筆而且某個值占過半
    const dflt = new Map()
    for (const [path, s] of seen) {
      const [v, c] = [...s.vals].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]
      if ((s.n >= 2 && s.vals.size === 1) || (s.n >= 3 && c > s.n / 2)) dflt.set(path, v)
    }
    noise.set(k, dflt)
  }
  return entries.map(e => ({ ...e, prefs: e.prefs.filter(p => noise.get(e.platform).get(p.path) !== JSON.stringify(p.to)) }))
}

// 一個控制項的紀錄（已正規化）；base＝同一頁「不操作」那次的量測
export const buildEntry = ({ platform, cat, item, via = '', run, base, initialMe, nowMs }) => {
  const before = baselineMe(initialMe, base.calls)
  const calls = dropNoise(run.calls.filter(c => !isMeSave(c)), base.calls.filter(c => !isMeSave(c)))
    .map(c => ({ cmd: c.cmd, args: maskTime(c.args, nowMs), ...(c.err ? { err: c.err } : {}) }))
  return {
    platform, cat, ...(via ? { via } : {}), kind: item.kind, label: item.label, nth: item.nth,
    input: run.input,
    ...(run.reveals?.length ? { reveals: run.reveals.map(r => `${r.kind}|${r.label}#${r.nth}`) } : {}),
    calls,
    prefs: maskTime(diffPrefs(before, run.calls), nowMs),
    storage: diffStorage(run.ls0, run.ls1),
    ...(run.opened.length ? { opened: run.opened } : {}),
    dialog: run.dialog ?? null,
    ...(run.acts?.length ? { acts: [...new Set(run.acts.map(a => a.op))] } : {}),   // 只供 SETTING_OPS 覆蓋對照；比對時不看（內部接線不算使用者看得到的效果）
  }
}

// ---------- 比對 ----------
// 回傳 { ok, missing（golden 有、這次沒有）, extra（這次有、golden 沒有）, changed（兩邊都有但內容不同）}
const visible = ({ acts, ...rest }) => rest   // acts（內部 op 名）不參與比對
export const compareEffects = (golden, latest) => {
  const g = new Map((golden.entries ?? []).map(e => [entryId(e), visible(e)]))
  const l = new Map((latest.entries ?? []).map(e => [entryId(e), visible(e)]))
  const missing = [...g.keys()].filter(k => !l.has(k))
  const extra = [...l.keys()].filter(k => !g.has(k))
  const changed = [...g.keys()].filter(k => l.has(k) && !same(g.get(k), l.get(k))).map(k => ({ id: k, golden: g.get(k), latest: l.get(k) }))
  return { ok: !missing.length && !extra.length && !changed.length, missing, extra, changed }
}
export const describeChange = c => {
  const parts = []
  const gc = c.golden.calls.map(x => x.cmd).join('→') || '(無指令)', lc = c.latest.calls.map(x => x.cmd).join('→') || '(無指令)'
  if (gc !== lc) parts.push(`指令序列 ${gc} ⇒ ${lc}`)
  else if (!same(c.golden.calls, c.latest.calls)) parts.push('指令參數不同')
  if (!same(c.golden.prefs, c.latest.prefs)) parts.push('prefs 欄位差異不同')
  if (!same(c.golden.storage, c.latest.storage)) parts.push('localStorage 差異不同')
  if (!same(c.golden.opened ?? [], c.latest.opened ?? [])) parts.push('開出的連結不同')
  if (c.golden.dialog !== c.latest.dialog) parts.push(`彈出的確認框 ${c.golden.dialog} ⇒ ${c.latest.dialog}`)
  if (c.golden.input !== c.latest.input) parts.push(`輸入 ${c.golden.input} ⇒ ${c.latest.input}`)
  if (c.golden.platformOnly !== c.latest.platformOnly) parts.push('平台專屬標記不同')
  return `${c.id}：${parts.join('；') || '內容不同'}`
}
