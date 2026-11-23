// 冒煙探測「手機設備列雲端標示檢查」（probe.mcloud）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const mcloudProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes('設備')) || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到設定裡的「設備」' };
  btn.click();
  await sleep(500);
  // 不點進任何一台：進設備頁時就會把各台的帳號回報讀進來（#930），讀到之後雲端節點才標得出來；最多等 3 秒
  const tagged = () => [...document.querySelectorAll('.m-dv-row .m-dv-rs')].filter(e => e.textContent.includes('雲端')).length;
  for (let i = 0; i < 30 && tagged() < 3; i++) await sleep(100);
  await sleep(300);
  const rows = [...document.querySelectorAll('.m-dv-row')].filter(e => e.offsetParent !== null).map(r => ({ name: r.querySelector('.m-dv-rn b')?.textContent.trim() ?? '', kind: r.querySelector('.m-dv-rs')?.textContent.trim() ?? '' }));
  const row = name => rows.find(r => r.name === name);
  for (const name of ['牧陽 Aegis', '日本VM', 'Grok 雲端']) {
    const r = row(name);
    if (!r) return { ok: false, why: '找不到「' + name + '」那列（各自一列）：' + rows.map(x => x.name).join('／') };
    if (!r.kind.startsWith('雲端')) return { ok: false, why: '「' + name + '」沒標雲端：' + r.kind };
  }
  const pc = row('辦公室');
  if (!pc || pc.kind.includes('雲端')) return { ok: false, why: '實體電腦不該標雲端：' + (pc?.kind ?? '找不到') };
  const me = rows.find(r => r.kind.includes('運作中'));   // 本機那一列只寫「手機 · 運作中」
  if (!me) return { ok: false, why: '找不到這支手機那列' };
  if (!me.kind.startsWith('手機') || me.kind.includes('雲端')) return { ok: false, why: '這支手機要是「手機」、不標雲端：' + me.kind };
  return { ok: true, why: '' };
})()`

export default {
  key: 'mcloud',
  kind: '手機設備列雲端標示檢查',
  source: probe => mcloudProbeSource(probe),
}
