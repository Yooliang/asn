// 釘選徽章：頭像右下角的藍色小圓圈，裡面一支圖釘（電腦名單、手機名單共用，三種外觀同一個元件；樣式在 style.css 的 .pin-dot）。
// 放在頭像的外框裡（.avb 或 .m-av-wrap，兩者都是 position:relative）。這個檔在 node 也要能載入，所以不取用 Vue。
export const PinDot = {
  name: 'PinDot',
  template: `<span class="pin-dot" role="img" aria-label="已釘選" title="已釘選"><svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path d="M9 3h6l-1 6 3 3v2h-4v6l-1 1-1-1v-6H7v-2l3-3z" fill="currentColor"/></svg></span>`,
}
