// 名單「分頁依廠商」用小圖示：自繪簡化標誌（非官方商標），深淺色皆用 currentColor + 固定色塊。
// 授權說明見 docs/ASN-VENDOR-ICONS.md

const SVG = {
  claude: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3c-2.2 0-4 1.6-4.3 3.7C5.8 7.5 4 9.6 4 12.2c0 3.4 2.8 6.2 6.2 6.2 1.1 0 2.1-.3 3-.8.9.5 1.9.8 3 .8 3.4 0 6.2-2.8 6.2-6.2 0-2.6-1.8-4.7-3.7-5.5C16 4.6 14.2 3 12 3z" fill="#d97757"/><path d="M9.5 11.2h5v1.6h-5z" fill="#fff"/></svg>',
  codex: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7.5 12c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5-2 4.5-4.5 4.5" fill="none" stroke="#10a37f" stroke-width="1.8" stroke-linecap="round"/></svg>',
  gpt: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7.5 12c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5-2 4.5-4.5 4.5" fill="none" stroke="#10a37f" stroke-width="1.8" stroke-linecap="round"/></svg>',
  gemini: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 4l2.8 5.8L21 12l-6.2 2.2L12 20l-2.8-5.8L3 12l6.2-2.2z" fill="#4285f4"/><path d="M12 8.2l1.4 2.9 3.2 1.1-3.2 1.1L12 16.2l-1.4-2.9-3.2-1.1 3.2-1.1z" fill="#34a853"/></svg>',
  grok: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 14c1.2-3 2.2-4.5 4-4.5s2.8 1.5 4 4.5" fill="none" stroke="#111" stroke-width="1.8" stroke-linecap="round"/><circle cx="9.5" cy="10" r="1.1" fill="currentColor"/><circle cx="14.5" cy="10" r="1.1" fill="currentColor"/></svg>',
  deepseek: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 18L12 5l7 13H5z" fill="none" stroke="#2563eb" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 14h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  pi: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 16V8h2.2c1.8 0 2.8 1 2.8 2.4S13 12.8 11.2 12.8H11v3.2H9z" fill="currentColor"/></svg>',
  acp: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 10h8M8 14h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  other: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="6" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="18" cy="12" r="2" fill="currentColor"/></svg>',
}

export const VENDOR_ICON_KEYS = Object.keys(SVG)

export function vendorIconSvg(engineKey) {
  const k = String(engineKey ?? '').trim().toLowerCase()
  return SVG[k] ?? SVG.other
}
