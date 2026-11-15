// 冒煙探測「電腦版關於區檢查」（probe.aboutCheck）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const aboutProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let intro = null;
  for (let i = 0; i < 60 && !intro; i++) { intro = document.querySelector('.settings .about-intro'); if (!intro) await sleep(200); }
  if (!intro) return { ok: false, why: '設定的「關於」沒有出現' };
  const root = intro.closest('.settings');
  const text = root.textContent;
  const missing = ['Agent Sync Network', '版本 ', '官網', '版本紀錄', '隱私權政策', '使用指引', '檢視記錄', 'Yooliang'].filter(w => !text.includes(w));
  if (missing.length) return { ok: false, why: '「關於」少了：' + missing.join('、') };
  const btns = [...root.querySelectorAll('.about-links button')].map(b => b.textContent.trim());
  if (btns.join('|') !== '官網|版本紀錄|隱私權政策|使用指引') return { ok: false, why: '連結按鈕不對：' + btns.join('|') };
  if (root.scrollWidth > root.clientWidth + 1) return { ok: false, why: '「關於」內容超出設定窗寬度' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'aboutCheck',
  kind: '電腦版關於區檢查',
  source: () => aboutProbeSource(),
}
