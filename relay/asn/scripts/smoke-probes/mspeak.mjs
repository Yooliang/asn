// 冒煙探測「手機念出訊息的喇叭鈕」（probe.mspeak，#2304）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 檢查：對方的每則訊息旁有喇叭鈕、在螢幕內；按下去外殼收到要念的文字（沒有排版符號）、鈕變成「停止」；再按一次外殼收到停止。
// 最後留在「念出中」的樣子，讓截圖看得到停止鈕。

export const mspeakProbeSource = () => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  let btns = [];
  for (let i = 0; i < 60 && !btns.length; i++) { btns = [...document.querySelectorAll('.m-chat .chatpane .msg .spk')].filter(vis); if (!btns.length) await sleep(100) }
  if (!btns.length) return { ok: false, why: '對方的訊息旁沒有喇叭鈕' };
  const W = innerWidth;
  for (const b of btns) { const r = b.getBoundingClientRect(); if (r.left < -0.5 || r.right > W + 0.5 || r.width < 1) return { ok: false, why: '喇叭鈕跑出螢幕或看不到：' + Math.round(r.left) + '～' + Math.round(r.right) } }
  const first = btns[0];
  if (first.getAttribute('aria-label') !== '念出這則訊息') return { ok: false, why: '喇叭鈕的名稱不對：' + first.getAttribute('aria-label') };
  first.click(); await sleep(250);
  const said = (globalThis.__smokeSpeak || []).filter(x => x && x.text);
  if (!said.length) return { ok: false, why: '按了喇叭鈕，外殼沒有收到要念的文字' };
  if (/[*#\`>|~_]|https?:/.test(said.map(x => x.text).join(''))) return { ok: false, why: '念出的文字還有排版符號或網址：' + said.map(x => x.text).join('') };
  if (!first.classList.contains('on') || first.getAttribute('aria-label') !== '停止念出') return { ok: false, why: '念的時候喇叭鈕沒有變成停止' };
  first.click(); await sleep(250);
  if (!(globalThis.__smokeSpeak || []).includes('stop')) return { ok: false, why: '再按一次，外殼沒有收到停止' };
  if (first.classList.contains('on')) return { ok: false, why: '停止後喇叭鈕還是停止樣子' };
  first.click(); await sleep(250);   // 留在念出中，截圖看得到停止鈕
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: String(e && e.message || e) } }
})()`

export default {
  key: 'mspeak',
  kind: '手機念出訊息的喇叭鈕',
  source: () => mspeakProbeSource(),
  table: scenario => (scenario.state?.mSpeak ? { __speak: true } : undefined),   // 假的念出外殼（smoke-lib 的 injectSource 讀 __speak）
}
