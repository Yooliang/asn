// 冒煙探測「拍照鈕檢查」（probe.camera）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

// 拍照（#1490）：手機的對話輸入列有「拍照」鈕（三種外觀都有），按下去開的是帶 capture 的選檔（WebView 交給系統相機），拍好就送出；電腦沒有這顆鈕
export const cameraProbeSource = mode => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const vis = e => e && e.getClientRects().length > 0;
  let pane = null;
  for (let i = 0; i < 60 && !pane; i++) { pane = [...document.querySelectorAll('.chatpane')].find(vis) || null; if (!pane) await sleep(100) }
  if (!pane) return { ok: false, why: '找不到對話' };
  await sleep(300);
  let btn = pane.querySelector('button.cam');
  if (${JSON.stringify(mode)} === 'desk') return btn ? { ok: false, why: '電腦版不該有拍照鈕' } : { ok: true, why: '' };
  // 現代外觀：附件類的鈕收在「＋」選單裡，先真的點開
  const plus = pane.querySelector('button.mc-plus');
  if (!vis(btn) && vis(plus)) { globalThis.__smokeInput(JSON.stringify({ click: at(plus) })); await sleep(400); btn = pane.querySelector('button.cam') }
  if (!vis(btn)) return { ok: false, why: '手機的輸入列沒有拍照鈕' };
  if (btn.getAttribute('aria-label') !== '拍照') return { ok: false, why: '拍照鈕的說明不對' };
  const input = pane.querySelector('input[type="file"][capture]');
  if (!input || input.getAttribute('capture') !== 'environment' || input.getAttribute('accept') !== 'image/*' || input.multiple) return { ok: false, why: '拍照的選檔欄位要是 accept=image/* capture=environment、單張' };
  globalThis.__smokeCalls = [];
  globalThis.__smokeChooser = undefined;
  globalThis.__smokeInput(JSON.stringify({ choose: [...at(btn), 'ok1.png'] }));
  for (let i = 0; i < 60 && globalThis.__smokeChooser === undefined; i++) await sleep(100);
  if (!globalThis.__smokeChooser) return { ok: false, why: '按拍照鈕沒有打開選檔（相機）' };
  if (globalThis.__smokeChooser.mode !== 'selectSingle') return { ok: false, why: '拍照應該只拍一張：' + globalThis.__smokeChooser.mode };
  let sent = [];
  for (let i = 0; i < 60; i++) { sent = (globalThis.__smokeCalls || []).filter(c => c[0] === 'relay_send_attachment'); if (sent.length) break; await sleep(100) }
  if (sent.length !== 1) return { ok: false, why: '拍好的照片沒有送出' };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

export default {
  key: 'camera',
  kind: '拍照鈕檢查',
  source: probe => cameraProbeSource(probe.camera),
}
